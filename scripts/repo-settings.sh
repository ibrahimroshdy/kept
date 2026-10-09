#!/usr/bin/env bash
# Kept's GitHub repository settings, as code (go-public plan §5; audit 5.9, 5.11, 5.12, 5.15).
# Idempotent: it reads every setting first and writes only what differs. The runbook
# (docs/runbooks/repo-settings.md) says what each setting is for and when to run this.
#
# Usage: scripts/repo-settings.sh [--dry-run] [options]
#   --dry-run                 read everything, print current -> intended, change nothing
#   --repo OWNER/NAME         default: the repository of this checkout's `origin`
#   --only LIST               comma-separated groups (below); default: every group the repository's
#                             visibility allows (see "Visibility")
#   --allow-admin-bypass      the main ruleset lets the admin role bypass it (default: no bypass,
#                             the maintainer works through pull requests too)
#   --required-checks         put the required status checks in the main ruleset even while private
#   --no-required-checks      leave them out even when public
#   --pin-action-shas         allow third-party actions at their exact pinned SHA only, instead of
#                             any ref of the same action (see the actions group)
#   --dependabot-security-updates
#                             also switch on Dependabot security updates (default off: Renovate
#                             opens the update pull requests, audit 5.12)
#
# Groups: merge, features, metadata, security, actions, tag-ruleset, main-ruleset, pages.
#
# Visibility. While the repository is private the script applies only what is safe and available
# on a private repository of a GitHub Pro account, and reports the rest as "needs public":
#   - secret scanning, push protection, private vulnerability reporting: public repositories only
#     on a user-owned repository (GitHub docs, reusables/gated-features: secret-scanning,
#     private-vulnerability-reporting);
#   - Pages: the docs workflow only runs once public, so its source is set at the flip;
#   - the allowed-actions list: `patterns_allowed` "only applies to public repositories" (REST
#     reference, PUT /repos/{owner}/{repo}/actions/permissions/selected-actions); switching to
#     "selected" while private would block the third-party action release.yml uses;
#   - the main ruleset: it blocks direct pushes to main, which is how main moves while private.
#     It is deferred until public unless asked for with `--only main-ruleset`.
#
# Needs: gh (authenticated as an account with admin on the repository) and jq.
# Every endpoint and field is from GitHub's REST description (github/rest-api-description); the
# repository-role id 5 = admin is from the terraform provider's ruleset docs and GitHub's own
# docs repository scripts (the REST description does not list role ids).
set -euo pipefail

dry=
repo=
only=
bypass=
checks=auto
pin_shas=
dep_updates=

usage() { sed -n '6,21p' "$0" | sed 's/^# \{0,1\}//'; }
while (($#)); do
  case $1 in
    --dry-run) dry=1 ;;
    --repo) repo=${2:?--repo needs OWNER/NAME}; shift ;;
    --only) only=${2:?--only needs a list}; shift ;;
    --allow-admin-bypass) bypass=1 ;;
    --required-checks) checks=on ;;
    --no-required-checks) checks=off ;;
    --pin-action-shas) pin_shas=1 ;;
    --dependabot-security-updates) dep_updates=1 ;;
    -h | --help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

die() { echo "repo-settings: $*" >&2; exit 1; }
command -v gh >/dev/null || die "gh is not installed"
command -v jq >/dev/null || die "jq is not installed"
cd "$(dirname "$0")/.."

[[ -n $repo ]] || repo=$(gh repo view --json nameWithOwner -q .nameWithOwner) ||
  die "cannot tell the repository; pass --repo OWNER/NAME"

# ---- reads ---------------------------------------------------------------------------------------
repo_json=$(gh api "repos/$repo")
[[ $(jq -r '.permissions.admin' <<<"$repo_json") == true ]] ||
  die "the active gh account ($(gh api user -q .login)) is not an admin of $repo; switch with: gh auth switch -u <owner>"
private=$(jq -r '.private' <<<"$repo_json")
visibility=$(jq -r '.visibility' <<<"$repo_json")

# The HTTP status of a GET, for endpoints that answer 204/404 rather than a body.
http_status() { { gh api -i "$1" 2>/dev/null || true; } | head -1 | awk '{print $2}'; }

# ---- output --------------------------------------------------------------------------------------
changes=0
deferred=()
section() { printf '\n== %s\n' "$1"; }
# show NAME CURRENT INTENDED [STATE]; STATE is "public" for a setting that waits for the flip.
show() {
  local name=$1 cur=$2 want=$3 state=${4:-}
  if [[ $state == public ]]; then
    printf '  %-34s %s -> %s   (needs public: deferred)\n' "$name" "$cur" "$want"
    deferred+=("$name")
  elif [[ $cur == "$want" ]]; then
    printf '  %-34s %s   (ok)\n' "$name" "$cur"
  else
    printf '  %-34s %s -> %s\n' "$name" "$cur" "$want"
    changes=$((changes + 1))
  fi
}
# apply DESCRIPTION -- COMMAND...; prints what it would do on a dry run.
apply() {
  local desc=$1; shift; [[ $1 == -- ]] && shift
  if [[ -n $dry ]]; then printf '  would: %s\n' "$desc"; else printf '  apply: %s\n' "$desc"; "$@" >/dev/null; fi
}
api_json() { local method=$1 path=$2 body=$3; gh api -X "$method" "$path" --input - <<<"$body"; }

# ---- which groups ------------------------------------------------------------------------------
all_groups=(merge features metadata security actions tag-ruleset main-ruleset pages)
if [[ -n $only ]]; then
  IFS=, read -r -a groups <<<"$only"
  for g in "${groups[@]}"; do [[ " ${all_groups[*]} " == *" $g "* ]] || die "unknown group: $g"; done
else
  groups=("${all_groups[@]}")
fi
want() { [[ " ${groups[*]} " == *" $1 "* ]]; }
explicit() { [[ ",$only," == *",$1,"* ]]; }

echo "repository: $repo ($visibility)$([[ -n $dry ]] && echo '   DRY RUN: nothing is changed')"

# ---- pages (before metadata: the homepage is the Pages URL) ---------------------------------------
pages_json=
pages_code=$(http_status "repos/$repo/pages")
[[ $pages_code == 200 ]] && pages_json=$(gh api "repos/$repo/pages")
if want pages; then
  section "pages (source: GitHub Actions; docs.yml builds and deploys the site)"
  cur=$([[ -n $pages_json ]] && jq -r '.build_type // "?"' <<<"$pages_json" || echo "not set up")
  if [[ $private == true ]]; then
    show "pages build_type" "$cur" workflow public
  else
    show "pages build_type" "$cur" workflow
    if [[ -z $pages_json ]]; then
      apply "create the Pages site with build_type=workflow" -- \
        api_json POST "repos/$repo/pages" '{"build_type":"workflow"}'
      [[ -z $dry ]] && pages_json=$(gh api "repos/$repo/pages")
    elif [[ $cur != workflow ]]; then
      apply "set the Pages build_type to workflow" -- \
        api_json PUT "repos/$repo/pages" '{"build_type":"workflow"}'
    fi
  fi
  # docs.yml deploys from a release tag (the site matches the latest release, not main), and
  # GitHub creates the github-pages environment allowing main only: add a tag policy for v*.
  env_path="repos/$repo/environments/github-pages/deployment-branch-policies"
  if [[ $(http_status "$env_path") == 200 ]]; then
    cur=$(gh api "$env_path" --jq '[.branch_policies[] | select(.type == "tag" and .name == "v*")] | length')
    show "github-pages deploys from tags v*" "$([[ $cur -gt 0 ]] && echo yes || echo no)" yes
    [[ $cur -gt 0 ]] || apply "allow the github-pages environment to deploy from tags v*" -- \
      api_json POST "$env_path" '{"name":"v*","type":"tag"}'
  else
    printf '  %-34s %s\n' "github-pages deploys from tags v*" "(no github-pages environment yet: rerun after the first deploy)"
  fi
fi

# ---- merge ---------------------------------------------------------------------------------------
# Squash only, the PR title as the commit title (Conventional Commits live in PR titles), the
# branch commits as its body (keeps each commit's Signed-off-by), branches deleted on merge,
# auto-merge allowed, "update branch" always offered, sign-off required on web commits (DCO, D5).
merge_want='{
  "allow_squash_merge": true, "allow_merge_commit": false, "allow_rebase_merge": false,
  "squash_merge_commit_title": "PR_TITLE", "squash_merge_commit_message": "COMMIT_MESSAGES",
  "delete_branch_on_merge": true, "allow_auto_merge": true, "allow_update_branch": true,
  "web_commit_signoff_required": true
}'
if want merge; then
  section "merge"
  diff=0
  for k in $(jq -r 'keys_unsorted[]' <<<"$merge_want"); do
    c=$(jq -r --arg k "$k" '.[$k]' <<<"$repo_json"); w=$(jq -r --arg k "$k" '.[$k]' <<<"$merge_want")
    show "$k" "$c" "$w"; [[ $c == "$w" ]] || diff=1
  done
  ((diff)) && apply "PATCH repos/$repo (merge settings)" -- api_json PATCH "repos/$repo" "$merge_want"
fi

# ---- features ------------------------------------------------------------------------------------
# Issues and Discussions on; the wiki and classic projects off (the docs site is the documentation).
if want features; then
  section "features"
  feat_want='{"has_issues": true, "has_wiki": false, "has_projects": false}'
  diff=0
  for k in has_issues has_wiki has_projects; do
    c=$(jq -r --arg k "$k" '.[$k]' <<<"$repo_json"); w=$(jq -r --arg k "$k" '.[$k]' <<<"$feat_want")
    show "$k" "$c" "$w"; [[ $c == "$w" ]] || diff=1
  done
  ((diff)) && apply "PATCH repos/$repo (issues, wiki, projects)" -- api_json PATCH "repos/$repo" "$feat_want"
  # has_discussions is in the repository's GET response but not in the documented PATCH body, so
  # it goes through gh's own flag.
  c=$(jq -r '.has_discussions' <<<"$repo_json")
  show has_discussions "$c" true
  [[ $c == true ]] || apply "gh repo edit $repo --enable-discussions" -- gh repo edit "$repo" --enable-discussions
fi

# ---- metadata ------------------------------------------------------------------------------------
description="Self-hosted, open-source inventory of everything you own and where it is. AI assistant and MCP server built in."
topics=(self-hosted home-inventory inventory ai ai-agents agentic-ai mcp mcp-server model-context-protocol pwa typescript fastify react postgres kubernetes helm arabic rtl agpl)
if want metadata; then
  section "metadata"
  c=$(jq -r '.description // "(none)"' <<<"$repo_json")
  show description "$c" "$description"
  [[ $c == "$description" ]] ||
    apply "set the description" -- api_json PATCH "repos/$repo" "$(jq -n --arg d "$description" '{description: $d}')"
  # The homepage is the Pages site's own URL, read from the Pages API; unset until Pages exists.
  # Kept's site is a project site under the maintainer's user site, which has the custom domain
  # ibrahimroshdy.com, so html_url already carries that domain (…/kept/); nothing here hard-codes it.
  # The API gives it as http:// while the user site doesn't enforce HTTPS (seen 2026-10-07 on his
  # other project sites), though the domain serves HTTPS; the homepage is always the https:// one.
  c=$(jq -r '.homepage // "" | if . == "" then "(none)" else . end' <<<"$repo_json")
  if [[ -n $pages_json ]]; then
    home=$(jq -r '.html_url | sub("^http://"; "https://")' <<<"$pages_json")
    show homepage "$c" "$home"
    [[ $c == "$home" ]] ||
      apply "set the homepage to the Pages URL" -- api_json PATCH "repos/$repo" "$(jq -n --arg h "$home" '{homepage: $h}')"
  else
    show homepage "$c" "(the Pages URL, once Pages exists)" "$([[ $private == true ]] && echo public)"
  fi
  c=$(jq -r '.topics | sort | join(",")' <<<"$repo_json"); [[ -n $c ]] || c="(none)"
  w=$(printf '%s\n' "${topics[@]}" | sort | paste -sd, -)
  show topics "$c" "$w"
  [[ $c == "$w" ]] || apply "replace the topics" -- \
    api_json PUT "repos/$repo/topics" "$(printf '%s\n' "${topics[@]}" | jq -R . | jq -s '{names: .}')"
fi

# ---- security ------------------------------------------------------------------------------------
if want security; then
  section "security"
  # Dependabot alerts (and the dependency graph): available on private repositories too.
  c=$([[ $(http_status "repos/$repo/vulnerability-alerts") == 204 ]] && echo on || echo off)
  show "dependabot alerts" "$c" on
  [[ $c == on ]] || apply "enable Dependabot alerts" -- gh api -X PUT "repos/$repo/vulnerability-alerts"
  # Dependabot security updates: off unless asked for; Renovate opens the update pull requests.
  c=$(gh api "repos/$repo/automated-security-fixes" -q 'if .enabled then "on" else "off" end' 2>/dev/null) || c=unavailable
  w=$([[ -n $dep_updates ]] && echo on || echo off)
  show "dependabot security updates" "$c" "$w"
  if [[ $c != "$w" ]]; then
    if [[ $w == on ]]; then
      apply "enable Dependabot security updates" -- gh api -X PUT "repos/$repo/automated-security-fixes"
    else
      apply "disable Dependabot security updates" -- gh api -X DELETE "repos/$repo/automated-security-fixes"
    fi
  fi
  # Secret scanning and push protection: public only on a user-owned repository.
  sa=$(jq -c '.security_and_analysis' <<<"$repo_json")
  ss=$(jq -r '.secret_scanning.status // "unavailable"' <<<"$sa")
  pp=$(jq -r '.secret_scanning_push_protection.status // "unavailable"' <<<"$sa")
  if [[ $private == true ]]; then
    show "secret scanning" "$ss" enabled public
    show "secret scanning push protection" "$pp" enabled public
  else
    show "secret scanning" "$ss" enabled
    show "secret scanning push protection" "$pp" enabled
    [[ $ss == enabled && $pp == enabled ]] || apply "enable secret scanning and push protection" -- \
      api_json PATCH "repos/$repo" '{"security_and_analysis":{"secret_scanning":{"status":"enabled"},"secret_scanning_push_protection":{"status":"enabled"}}}'
  fi
  # Private vulnerability reporting (SECURITY.md's one channel): public repositories only.
  c=$(gh api "repos/$repo/private-vulnerability-reporting" -q 'if .enabled then "on" else "off" end' 2>/dev/null) || c=unavailable
  if [[ $private == true ]]; then
    show "private vulnerability reporting" "$c" on public
  else
    show "private vulnerability reporting" "$c" on
    [[ $c == on ]] || apply "enable private vulnerability reporting" -- gh api -X PUT "repos/$repo/private-vulnerability-reporting"
  fi
fi

# ---- actions -------------------------------------------------------------------------------------
if want actions; then
  section "actions"
  # The third-party actions the workflows use, read from the workflow files. GitHub-owned ones
  # (the `actions` organisation) are covered by github_owned_allowed.
  uses=()
  while IFS= read -r u; do uses+=("$u"); done < <(
    grep -hoE '^[[:space:]-]*uses:[[:space:]]*[^[:space:]#]+' .github/workflows/*.y*ml |
      sed -E 's/.*uses:[[:space:]]*//' | grep -vE '^(\./|docker://)' | sort -u)
  unpinned=$(printf '%s\n' ${uses[@]+"${uses[@]}"} | grep -vE '^$|@[0-9a-f]{40}$' || true)
  [[ -z $unpinned ]] || die "sha_pinning_required would break these unpinned actions: $unpinned"
  patterns=()
  for u in ${uses[@]+"${uses[@]}"}; do
    [[ $u == actions/* ]] && continue
    if [[ -n $pin_shas ]]; then patterns+=("$u"); else patterns+=("${u%@*}@*"); fi
  done

  perm=$(gh api "repos/$repo/actions/permissions")
  c=$(jq -r '.allowed_actions' <<<"$perm")
  if [[ $private == true ]]; then
    show "allowed actions" "$c" selected public
    want_allowed=$c
  else
    show "allowed actions" "$c" selected
    want_allowed=selected
  fi
  cs=$(jq -r '.sha_pinning_required' <<<"$perm")
  show "sha pinning required" "$cs" true
  if [[ $c != "$want_allowed" || $cs != true ]]; then
    apply "PUT actions/permissions (allowed_actions=$want_allowed, sha_pinning_required=true)" -- \
      api_json PUT "repos/$repo/actions/permissions" \
      "$(jq -n --arg a "$want_allowed" '{enabled: true, allowed_actions: $a, sha_pinning_required: true}')"
  fi
  sel_want=$(printf '%s\n' ${patterns[@]+"${patterns[@]}"} | grep -v '^$' | jq -R . | jq -s '{github_owned_allowed: true, verified_allowed: false, patterns_allowed: (. | sort)}')
  if [[ $c == selected ]]; then
    sel=$(gh api "repos/$repo/actions/permissions/selected-actions" | jq -c '{github_owned_allowed, verified_allowed, patterns_allowed: (.patterns_allowed | sort)}')
  else
    sel="(not selected: every action allowed)"
  fi
  w=$(jq -c . <<<"$sel_want")
  if [[ $private == true ]]; then
    show "selected actions" "$sel" "$w" public
  else
    show "selected actions" "$sel" "$w"
    [[ $sel == "$w" ]] || apply "PUT actions/permissions/selected-actions" -- \
      api_json PUT "repos/$repo/actions/permissions/selected-actions" "$sel_want"
  fi

  wf=$(gh api "repos/$repo/actions/permissions/workflow" -q '"\(.default_workflow_permissions), approve PRs: \(.can_approve_pull_request_reviews)"')
  show "default GITHUB_TOKEN" "$wf" "read, approve PRs: false"
  [[ $wf == "read, approve PRs: false" ]] || apply "set the default workflow token to read-only" -- \
    api_json PUT "repos/$repo/actions/permissions/workflow" '{"default_workflow_permissions":"read","can_approve_pull_request_reviews":false}'
fi

# ---- rulesets ------------------------------------------------------------------------------------
existing_rulesets=$(gh api "repos/$repo/rulesets")
# The differences between a live ruleset and the intended one, one line each (empty when equal).
# Only the parameters the intended rule names are compared; GitHub adds defaults of its own. A
# boolean parameter that is false comes back absent (seen 2026-10-07: the tag ruleset's update rule
# with update_allows_fetch_and_merge false is returned as {"type": "update"}, no parameters), so an
# absent parameter equals an intended false.
ruleset_diff() {
  jq -rn --argjson cur "$1" --argjson want "$2" '
    def norm: if type == "array" then (map(norm) | sort_by(tostring)) elif type == "object" then with_entries(.value |= norm) else . end;
    ($cur.rules | map({key: .type, value: (.parameters // {})}) | from_entries) as $c
    | ($want.rules | map(.type)) as $wt
    | [ (if $cur.enforcement != $want.enforcement then "enforcement \($cur.enforcement) -> \($want.enforcement)" else empty end),
        (if ($cur.conditions | norm) != ($want.conditions | norm) then "conditions \($cur.conditions | tojson) -> \($want.conditions | tojson)" else empty end),
        (if ([$cur.bypass_actors[]? | {actor_id, actor_type, bypass_mode}] | norm) != ($want.bypass_actors | norm)
          then "bypass \([$cur.bypass_actors[]? | {actor_id, actor_type, bypass_mode}] | tojson) -> \($want.bypass_actors | tojson)" else empty end),
        ($want.rules[] | . as $r
          | if ($c | has($r.type) | not) then "add rule \($r.type)"
            else ($r.parameters // {} | to_entries[]
              | select((.value | norm) != ($c[$r.type][.key] | norm))
              | select((.value == false and $c[$r.type][.key] == null) | not)
              | "rule \($r.type).\(.key): \($c[$r.type][.key] | tojson) -> \(.value | tojson)")
            end),
        ($cur.rules[] | select(.type as $t | $wt | index($t) | not) | "remove rule \(.type)")
      ] | .[]'
}
# upsert_ruleset LABEL BODY
upsert_ruleset() {
  local label=$1 body=$2 name id cur d
  name=$(jq -r .name <<<"$body")
  id=$(jq -r --arg n "$name" '.[] | select(.name == $n) | .id' <<<"$existing_rulesets" | head -1)
  if [[ -z $id ]]; then
    show "$label" "(none)" "ruleset \"$name\""
    printf '  intended: %s\n' "$(jq -c . <<<"$body")"
    apply "create ruleset \"$name\"" -- api_json POST "repos/$repo/rulesets" "$body"
    return
  fi
  cur=$(gh api "repos/$repo/rulesets/$id")
  d=$(ruleset_diff "$cur" "$body")
  if [[ -z $d ]]; then
    show "$label" "ruleset \"$name\" (id $id)" "ruleset \"$name\" (id $id)"
  else
    show "$label" "ruleset \"$name\" (id $id)" "updated"
    sed 's/^/    /' <<<"$d"
    apply "update ruleset \"$name\" (id $id)" -- api_json PUT "repos/$repo/rulesets/$id" "$body"
  fi
}

admin_bypass='[{"actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "always"}]'

if want tag-ruleset; then
  section "tag ruleset (release tags v*: only the admin creates, moves or deletes them)"
  body=$(jq -n --argjson by "$admin_bypass" '{
    name: "release tags", target: "tag", enforcement: "active", bypass_actors: $by,
    conditions: {ref_name: {include: ["refs/tags/v*"], exclude: []}},
    rules: [{type: "creation"}, {type: "update", parameters: {update_allows_fetch_and_merge: false}}, {type: "deletion"}]}')
  upsert_ruleset "tag ruleset" "$body"
fi

if want main-ruleset; then
  section "main ruleset (the default branch: pull requests only)"
  if [[ $private == true ]] && ! explicit main-ruleset; then
    cur=$(jq -r '[.[] | select(.name == "main") | "ruleset \"main\" (id \(.id))"] | first // "(none)"' <<<"$existing_rulesets")
    show "main ruleset" "$cur" "ruleset \"main\"" public
    echo "  (it blocks direct pushes to main; apply at the flip, or now with --only main-ruleset)"
  else
    # The required checks: the job ids of ci.yml and docs.yml (a job without `name:` reports its
    # id), from the GitHub Actions app. Each is checked against the workflow file, so a renamed
    # job fails here rather than leaving a check that never reports.
    required=(ci.yml:fast ci.yml:db ci.yml:e2e ci.yml:images-amd64 ci.yml:images-arm64 ci.yml:helm ci.yml:attribution ci.yml:dco docs.yml:build)
    use_checks=$checks
    [[ $use_checks == auto ]] && { [[ $private == true ]] && use_checks=off || use_checks=on; }
    actions_app=$(gh api apps/github-actions -q .id)
    contexts='[]'
    if [[ $use_checks == on ]]; then
      for r in "${required[@]}"; do
        f=.github/workflows/${r%%:*} j=${r#*:}
        grep -qE "^  $j:[[:space:]]*$" "$f" || die "job '$j' is not in $f; update the required checks"
        contexts=$(jq --arg c "$j" --argjson app "$actions_app" '. + [{context: $c, integration_id: $app}]' <<<"$contexts")
      done
    else
      echo "  required status checks: left out ($([[ $checks == off ]] && echo '--no-required-checks' || echo 'private: no workflow runs yet'))"
    fi
    by='[]'; [[ -n $bypass ]] && by=$admin_bypass
    body=$(jq -n --argjson by "$by" --argjson checks "$contexts" '{
      name: "main", target: "branch", enforcement: "active", bypass_actors: $by,
      conditions: {ref_name: {include: ["~DEFAULT_BRANCH"], exclude: []}},
      rules: ([
        {type: "deletion"},
        {type: "non_fast_forward"},
        {type: "required_linear_history"},
        {type: "pull_request", parameters: {
          required_approving_review_count: 0, dismiss_stale_reviews_on_push: false,
          require_code_owner_review: false, require_last_push_approval: false,
          required_review_thread_resolution: true, allowed_merge_methods: ["squash"]}}
      ] + (if ($checks | length) > 0 then [{type: "required_status_checks", parameters: {
          strict_required_status_checks_policy: true, do_not_enforce_on_create: false,
          required_status_checks: $checks}}] else [] end))}')
    upsert_ruleset "main ruleset" "$body"
  fi
fi

# ---- summary -------------------------------------------------------------------------------------
echo
if [[ -n $dry ]]; then
  echo "dry run: $changes setting(s) would change now."
else
  echo "applied $changes change(s)."
fi
if ((${#deferred[@]})); then
  echo "waiting for the repository to be public (run again after the flip):"
  printf '  - %s\n' "${deferred[@]}"
fi
