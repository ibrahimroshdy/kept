# Kept — screens and flows

**Status: draft for implementation; nothing is built.** This document specifies each screen: what
it's for, how you get there, what's on it, its primary action, its states, and how it varies by
role, module and connection. It implements [product design](2026-09-25-kept-product-design.md)
**D174–D175**. Visual design follows D131–D135 and the [design board](../design/kept-design-board.html).
The mock-ups are on the [screens board](../design/kept-screens.html): 65 frames (56 from the design pass plus 9 from the final review) across phone and desktop, light, dark and Arabic, including the **People and types** section added in the final review (§9, D190–D196).

---

## 1. Navigation model

- **Views are global by default.** Home, Inbox, Search, Schedules, Lending, Paperwork, Vehicles
  and Insights span every location you belong to. A **location filter chip** narrows any of them;
  the choice is kept in the URL. Browsing the tree is naturally per location.
- **Nav entries follow modules across locations.** An entry shows if its module is on in **any** of
  your locations; lists inside it include only locations where that module is on.
- **Phone:**
  - Bottom tabs: **Home · Search · Capture (centre) · Inbox · More**.
  - Header on every screen: current title, the notification bell, the assistant button, and Scan
    (on Home and Search).
  - **More** = Locations (browse) · Vehicles · Schedules · Lending · Paperwork · Insights ·
    Activity · Trash · Notifications · Settings · Help.
- **Tablet (768 px) and up:** a sidebar with the same entries (Activity, Trash, Notifications and
  Help included, §8), plus a locations tree that can be
  collapsed; the assistant docks as a side panel (D24); ⌘K opens the palette.
- **The icon rail (D198).** The sidebar folds to a 64 px rail and back:
  - **Toggle:** a button pinned at the sidebar's foot, "Collapse sidebar" / "Expand sidebar"
    (`aria-expanded`), or `⌘\` / `Ctrl+\` (not while typing in a field). Focus stays on the entry
    that had it.
  - **In the rail:** each entry and location is its icon, with its name for screen readers and in a
    tooltip on hover and keyboard focus; later-step entries stay muted and focusable. The lockup
    becomes the square K mark, the Locations heading a rule, and the version footer a Source code
    icon with the version in its tooltip. Counts (Inbox) become a badge on the icon.
  - **Default and memory:** remembered per device and applied before first paint, like the theme.
    With no choice stored, 768–1023 px starts on the rail and 1024 px up expanded.
  - **Top bar:** at 768–1023 px the search field and Capture are icon buttons with tooltips;
    search opens the ⌘K palette. From 1024 px they're the full field and button.
  - **RTL:** the rail is on the inline-start edge and the toggle's chevron flips. Phones keep the
    tab bar.
- **Back:** Android back and the browser back close the top sheet first, then go back in history.

## 2. Routes

IDs, never place paths, so a move never breaks a link.

| Route | Screen |
|---|---|
| `/` | Home |
| `/loc/<id>` · `/p/<id>` · `/t/<id>` | Location · Place · Thing (a container opens on its Contents) |
| `/l/<code>` | Label resolution (D120, D137) |
| `/capture` · `/inbox` · `/search?q=` | Capture · Inbox · Search |
| `/vehicles` · `/schedules` · `/lending` · `/paperwork` · `/insights` · `/trash` · `/incidents` | Module screens |
| `/people/<id>` · `/vendors/<id>` · `/brands/<id>` · `/types/<id>` | Registries |
| `/reports/<kind>` | Insurance, vehicle history, box contents, claim pack |
| `/notifications` · `/activity` · `/assistant/<thread>` | Around the app |
| `/mcp` | MCP endpoint (Streamable HTTP, D63) |
| `/settings/me|location/<id>|account|ai|connections|import|export` · `/admin/*` | Settings and admin |
| `/settings/ai/usage?scope=me\|location\|account&location=<id>` · `/admin/ai/usage` | AI usage (D206) |
| `/s/<token>` | Public share page (no account) |
| `/setup` · `/invite#<token>` · `/signin` | Entry points (invite and magic-link tokens travel in the fragment and are consumed by POST, D181) |

Tabs, filters and open sheets are query parameters, so every state can be linked.

## 3. One rule for controls that can't be used

| Reason | Treatment |
|---|---|
| Your role can't do it | **Hidden** |
| The module is off in this location | Shown as "Off in this location", with "Ask an admin" or, for admins, "Turn on" |
| Offline, or the AI budget is paused | **Disabled with the reason** ("Needs a connection", "AI paused until 14:00 · Home's monthly cap reached", D206) |
| AI is waiting for the provider's rate limit | **Not disabled**: the work queues and its progress line says "Waiting for Groq · about 20 s" (D206) |
| Needs a setup step (no AI provider, no SMTP) | Disabled with the setup link (admins) or the reason (others) |

## 4. Offline matrix

| Works offline (from the snapshot, D36) | Needs a connection |
|---|---|
| Browse locations, places, containers; open a thing (never secrets or people's contact details; money and documents only for a location this device keeps offline, D159, behind the app lock, D181) | Editing details, settings, admin |
| Search (labelled "From this phone · details need a connection") | Assistant, AI extraction |
| Capture; move; log a reading; mark seen; not here; add a room or spot (queue op `create_area`, D172); box check; claim a blank label | Share links, exports, imports, reports |
| Scan a label (D137) | Anything touching money or secrets |

Every offline answer shows "as of last sync, 14:02" (D188).

## 5. Screens

Each entry: **purpose · entry points · contents (in order) · primary action · states · variants.**

### Home
- **Purpose:** what needs you, then where things are.
- **Entry:** tab / sidebar; app launch.
- **Contents:**
  1. The Get-started checklist (D138), with items depending on role: invited members don't see "connect AI" or "invite".
     - Over plain HTTP, the admin's first item is **"Put Kept on HTTPS"**, saying what HTTP loses: camera, install, push notifications and location (D193).
     - On Essentials, no AI setup item appears (here or in the attention panel) until a provider is connected or the user opens AI settings (D191).
  2. The **attention panel**, with one row per kind and a count: to review · overdue · due · expiring · lent out · borrowed in · uncertain · long unseen · Unplaced to sort · low stock. Zero-count rows are hidden (§8). Each row opens its filtered list.
  3. Recent activity: 3 items on the phone, 5 on desktop (§8).
  4. Locations as cards (name, kind icon, thing count, members; an optional cover photo, D195).
  5. After a location is created, an **"Invite people"** card for it (admins; the wizard no longer has an invite step, D194). It opens Invite (§5).
- **Primary action:** Capture (the tab).
- **States:** first run: the Personal card plus **Create your first home** (§8, D114); loading skeletons; offline banner.

### Location / Place / Container
- **Purpose:** what's here.
- **Contents:**
  - The breadcrumb path.
  - Children: places first, then things, following the list standard (search, filter, group, paginate). Sort
    (Name · Changed · Last seen, each either way) and grouping (None · Type) are the strip's Display button (D211).
  - "Add here": Thing · Box/container · **Room or spot** (D45; "room or spot" is the UI word for
    any place, product design §6.2).
  - Place fields (D160) and the location's paperwork (D155).
  - A container opened by scanning its label leads with a **photo grid** of what's inside (D195). List or photos
    is the Display menu's **Layout** section on a container's contents (D211), not a link of its own.
- **Actions:** Add here, Move here (from the **Carrying** tray, §6), Box check, Print labels, Export view (D169).
- **Location-only:**
  - Members (Members and roles, below), What to track and settings (for admins).
  - Unplaced ("Sort them": one-at-a-time triage with the move picker, or bulk select and move).
  - **Leave this location** (members, viewers, admins; not the owner).
- **Empty:** "Nothing here yet" → Capture here.

### Personal location (D5, D114)
- **Purpose:** things that are on you or yours alone (phone, wallet, keys).
- **Entry:** its card on Home, which is always there (§8); capture with no location lands in its
  Unplaced area (§8).
- **Contents:** the Location page above, minus everything about other people: **no Members, no
  Invite, no share links, no Leave** (D114). Created with the **Household** preset (engineering
  spec §7.10); What to track can change it.
- **Primary action:** Capture here.
- **Variants:** assistant turns here are paid by your own account (D121, D167). Moving a thing
  into a shared home is an ordinary Move.
- **Naming:** "Personal" stays. Renaming it "On me" is an open question for the maintainer (§9).

### Thing detail
- **Layout:** phone is one scrolling page with anchored section chips; desktop uses tabs. A
  container opens on **Contents**, with Details as a tab.
- **Header:**
  - The photo (swipe through photos).
  - Name and the ID chip ("ID pending" until synced). When the server allocates the ID, the chip
    animates like printed tape (off under reduced motion, D195).
  - The full path.
  - Derived state: lent, borrowed, in repair, uncertain, draft.
  - Lifecycle when it has ended.
- **Sections:**
  - Overview (type fields; Suggested values carry the "Suggested" marker, D131).
  - Paperwork and warranties. Each active warranty shows a **coverage bar** (bought → today →
    covered until). A claim that closes at no cost records "Warranty saved you <amount>" (D195).
  - Value (valuations, D158).
  - Meters, services and fuel (when metered). A vehicle's Readings tab (§8) carries the
    **odometer proof strip**, a timeline of dashboard photos; the vehicle history report reuses
    it (D195). "Log a service" opens the screen below.
  - Loans · Claims · Links · Schedules · History (the audit timeline with Undo, D150). History
    includes the **AI calls** that touched the thing (its extractions and embeddings), as a
    filterable kind "AI", each with model, tokens and ≈ cost (D206).
- **Action menu:**
  - Move · Lend / Borrow return · Label · Split · Duplicate · Save as template · Mark seen ·
    Not here.
  - Change lifecycle (with end details) · Re-type · Convert to place (containers) · Trash.
- **Editing:** an explicit **Edit** opens the fields in place; Save or Cancel; a conflict opens
  the field-level merge (§6).
- **Secrets:** "Reveal" shows the value for 30 s with "Revealed · logged" (D116); hidden again
  on leaving the page.
- **Variants:** viewers see no actions except Copy link (A viewer's thing detail, below); offline
  shows the snapshot version (§4).

### A viewer's thing detail
- **Purpose:** someone with read-only access can find and look, and nothing else.
- **Contents:** the Thing detail layout, unchanged in order, with:
  - no action menu, no Edit, no Capture here, no Mark seen or Not here (role matrix, product
    design §7.1);
  - money only if the location allows viewers to see it (D13);
  - a secret's Reveal only if that field's policy names the viewer (D116, D177).
- **Primary action:** **Copy link**, the only action.
- **Variants:** asking the assistant for a change gets "Viewers can't make changes here. Ask an
  admin of Home", with no card (§8).

### Log a service (D26, D29, D113)
- **Purpose:** record work done on a metered thing, and close the schedules it completes.
- **Entry:** a vehicle's Services tab; Thing detail → Log a service; "Complete" on a due schedule
  or its reminder.
- **Contents (phone, in order):**
  1. Date (today by default; not in the future).
  2. Odometer (or the thing's meter), checked against its neighbours (D112), with a **photo-proof
     slot** for the dashboard. The photo joins the odometer proof strip (D195).
  3. Vendor (from the registry, created inline, D11).
  4. The invoice attached: take a photo or pick a file. With AI capture on, extraction fills the
     line items as Suggested values (D131).
  5. Line items: part / labour / fluid, quantity and cost, with the total and its currency.
  6. **Completes:** the thing's schedules, each ticked when a line item matches it; the person can
     tick or untick any. Saving restarts each ticked schedule's count (D29).
  7. Notes.
- **Primary action:** Save.
- **States:** a reading that doesn't fit is refused at entry with the reason (D112); totals follow
  the Purchase rule (§7). Needs a connection, because it carries money (§4); a reading alone can
  still be logged offline.
- **Variants:** members add and edit their own; viewers can't open it. Service records are core
  (D113), so any metered thing has this screen.

### Capture (D18, D34)
- **Session:**
  - The camera stays open.
  - A counter shows "12 captured".
  - The **place chip** is pinned at the top and editable, suggesting the nearest location (D153),
    the last place, or the scanned box. Each shutter press drops a thumbnail into the chip (D195).
  - **The first capture into a new home** opens with a one-tap grid of its rooms; it doesn't
    quietly default to Unplaced (D194).
- **Controls:**
  - The mode strip (Thing · Receipt · Label · Reading).
  - The shutter.
  - **"+ photo to this thing"** beside it: a Label shot taken this way attaches to the current
    draft and fills its brand, model and serial.
  - The **Name** field, with dictation. When AI capture is off in the target location it is the
    primary input, labelled "Name", not "Name (optional)" (D194).
  - Gallery import (D140).
- **Receipt mode:** the camera shows **"Hold steady · fill the frame"**. There is no edge detection
  in the browser and it never says "Edges found"; the server crops during extraction (D196).
- **Drafts with AI on** show **"Naming…"** until extraction finishes, and can be found by their
  place and photo meanwhile (D194).
- **AI paused:** the paused banner under the place chip, "Photos still save; naming waits"
  (D206). Capture itself is never disabled by AI state.
- **Recognition:** a Kept label in view offers "Open Box 3 / Capture into Box 3" (D137).
- **Done:** a summary ("12 captured into Garage › Shelf A · 12 waiting to sync"), then back.
- **HTTP or camera denied:** the file picker (D31).

### Inbox (review)
- **Scope:** global with the location filter chip (§1), visible to members and above. **"Mine"** is the default filter; "Everyone's" is one tap away.
- **Kinds:**
  - Draft things (AI-filled or unnamed).
  - Readings that don't fit.
  - Lost label claims.
  - Needs a currency.
  - Likely duplicates.
  - Receipts (shared in, emailed, uploaded).
  - Sync drops that need a decision.
- **Grouping:** by capture batch, with kind filters (the list standard). A filter chip with a zero
  count is hidden, as in the attention panel (D191).
- **Per item:**
  - Photo and fields; Suggested values marked.
  - Accept, edit, move, set type.
  - For receipts: **"Link to an existing thing"**, with candidates by brand and model or by name
    in the same location. This is the normal J2 order: photo first, receipt later.
  - **The AI line** on anything AI filled: "Read by qwen/qwen3.8-27b (Groq) · 2,502 tokens ·
    ≈ USD 0.0039 · paid by Home"; tap for the call's detail (D206). Cost follows the money gate.
- **Multi-item drafts:**
  - Adjust a crop.
  - Merge N drafts into one quantity row.
  - Split.
  - Drop false detections.
- **Keyboard:** `j`/`k` next and previous · `a` accept · `e` edit · `m` move · `t` type · `x` select · `shift+a` accept selected.

### Search
- **Results** grouped by kind (things, places, people, vendors, documents with a receipt-text
  snippet), then by location. Each thing shows **its container's photo** beside the path (D195).
- **The D74 test:** on Essentials, the HDMI cable is found here; with a provider connected, also
  by asking the assistant (D194).
- **Filters:**
  - Location, place subtree, type, tags.
  - State: lent, borrowed, in repair, uncertain, draft.
  - Warranty active.
  - Money filters, for members and above.
- **Also:** recent searches; saved views, personal or shared (`saved_views`, D183).
- **Offline:** labelled as coming from the phone (§4).

### Assistant (D22–D24, D179)
- **Opening it:** a sheet from the header button (phone) or a docked panel (desktop).
- **Context and threads:** a removable **context chip** shows the current page. A threads list opens from the sheet's menu.
- **Confirmation card**, drawn by the app from the tool's arguments, never by model text:
  - Contents: the target (linked), each field before → after, the location, and a countdown.
  - **One card per batch**, with a checkbox per row.
  - When it expires: "Expired · ask again".
  - If the row changed since: a card-level conflict with both values.
- **Replies:** no remote images; links are internal only. An answer that locates a thing shows the
  container's photo beside the path, as Search does (D195).
- **Availability:** on in any preset once an AI provider is connected; the module switch can still
  turn it off (D191). While AI is paused the composer is disabled with the reason (D206).

### Type editor (D12, D92, D172)
- **Entry:** Account settings → Types (owner and admins).
- **Layout (desktop):** the tree on the left; the selected type on the right:
  1. Identity: **name** and the **icon picker** (Lucide or Tabler icons, D98).
  2. Capabilities (container, metered, warranty, serialized, consumable, expires on; D154).
  3. The **field list**, inherited fields first and marked with their source type. Each row: key,
     label, kind, required. A **secret** field shows a lock; its policy (who can reveal, AI
     allowed) and converting a field to or from secret are **owner only** (D177).
  4. **Field groups.** Built-in TV/display, phone, tablet, computer and network device share the
     **Device** group: OS and version, firmware, MAC address (repeatable: Wi-Fi and Ethernet),
     and the account or login it's tied to, stored as a secret. IMEI stays on phone and tablet
     (D192).
- **Impact preview** before saving:
  - Per location you can see: the things affected.
  - The descendant types that inherit the change.
  - The fields to be archived.
  - Locations you can't see appear as counts only (D123).
- **Other flows:** merging types uses the same preview. A cycle is refused with a message. "Required" applies to new edits only.
- **Place kinds** reuse the same field editor (D160).

### Settings (full page list)
- **Me:**
  - Profile, timezone (D122), units.
  - **Display** (D203, D204), device preferences kept per device and applied before first paint:
    - **Language:** a custom dropdown (React Aria Select, never a native select) of the five
      launch languages, each with an SVG flag and its own name: English, العربية, Français,
      Deutsch, Italiano. Arabic is the only right-to-left one. The sign-in pages carry the same
      picker in a small trigger.
    - **Digits** (Western 0123 / Eastern ٠١٢٣, D143): shown only while the language is Arabic.
    - **Theme:** System (the default, follows the device's light or dark live), Light, Dark.
    - **Content width:** Centered (the default) or Full width, a segmented control shown from
      768 px (phones always use their whole width). Full width lets lists, grids, tables, search
      results and activity use the space beside the sidebar or rail; running text keeps a
      readable measure and forms and dialogs keep their widths.
  - Notifications: channels, kinds per location, digest time, quiet hours, the calendar feed (D142).
  - "Suggest where I am" (D153); hidden modules.
  - Security: sessions and devices, passkeys, two-factor, backup codes.
  - Personal AI key; **my AI usage** (D206); my tokens; export my data; delete my account.
- **Location:**
  - Name, kind, cover photo (D195), address and coordinates, timezone, currency, aliases,
    languages. Timezone and currency start from the browser and locale when the location is
    created; aliases and languages are set only here (D194).
  - **General** (the first tab, before What to track and Members): the location's **languages**
    (D41, D204), a multi-select with the same flags and own names. They are the languages AI
    writes search aliases in. A stored regional tag (`ar-EG`) is kept; a new choice is stored as
    the bare language.
  - **What to track** (below); long-unseen months; money visible to viewers.
  - Require two-factor: a passkey with user verification counts. A member who hasn't enrolled can
    still sign in, but this location is hidden from them until they enrol (D190).
  - Members, roles and expiry (below); successor (D165); support access (D71).
  - Webhooks; mailbox (D21); share links.
  - **AI here** (D206): on or off (the AI capture and assistant modules), the location's monthly
    cap (owner), and its usage (admins and owner). No per-location key.
  - Transfer; delete (D149).
- **Account:** types, place kinds (D160), brands, vendors, people, templates, exchange rates.
- **AI:** see **AI settings** and **AI usage** below (D191, D202, D206).
  - Opens with **"What uses AI in Kept"**, then where the key lives, then **Paste your key → Test** (D191).
  - Under **Advanced**: per task, "Using: <provider/model> · from instance / account / you",
    with a **Test** button (D188); the cascade source; caps and budgets; the price table.
  - Keys are write-only ("Replace key"); usage.
  - A personal key carries the note "Used for Personal, your private threads, and questions that
    span owners" (D121, D167).
  - Members get a read-only status line.
- **Connections:**
  - Tokens (the only place tokens live, filtered by location).
  - Creation shows the token once, with a copy button and ready-made client configs.
  - A separate **Connected apps (OAuth)** list with revoke.
  - Webhooks; recent changes with undo.
- **Import / export:** the import stepper, §6.
- **Admin:**
  - Users (disable, reset two-factor, sign out everywhere; D165) and instance admins.
  - Sign-up and OIDC autoprovision; SMTP; storage; backups (restic).
  - Barcode lookup; SSRF allowances; former hostnames; extra currencies.
  - **AI** (D206): the instance key; the instance caps (overall, and the per-account allowance with
    overrides); the **price table** (versioned: each edit adds a version, with "Fill from the
    provider's listing" and "Cost this month's unpriced calls"); instance usage.
  - Failed jobs (D166); admin alert channels; status page; update check; recovery kit (CLI or step-up, D182).
  - The status page asks for the recovery-kit acknowledgement until it's given (D193).

### AI settings (D191, D202, D206)
- **Purpose:** connect a provider, see plainly what AI does and costs, and set limits.
- **Entry:** Settings → AI (the account's key, for owners); Settings → Me → Personal AI key;
  Admin → AI (the instance key); the Get-started "Connect AI" item; the "Set up AI" link wherever
  AI is off for lack of a provider (§3).
- **Contents (phone, in order):**
  1. **"What uses AI in Kept"**, always first, for everyone who can open the page:
     - A short table, one row per action: captured photo · receipt · label · reading · assistant
       question · semantic search · Test. Each row says how many AI calls it makes, the tokens
       including the image ("~2–3k"), and ≈ cost from the price table ("≈ USD 0.004"), or "add a
       price to see cost".
     - The basis under it: "From your last 30 days" or "Measured by Kept on 2026-09-26 with Groq"
       until there is enough history.
     - **The estimate:** "At your last 30 days' pace: ≈ USD 0.42 a month (118 calls)", or, with no
       history, "For example, 100 photos and 20 receipts a month ≈ 120 calls".
     - "What is sent" (below) as a one-line link.
  2. **Where your key lives**, in words: "This key pays for all of Alfred's homes: Home, Garage.
     Your Personal location uses your personal key if you add one." For a personal key: "Used for
     Personal, your private threads, and questions that span owners" (D121, D167). No location
     picker: there are no per-location keys.
  3. **Paste your key → Test** (D191).
     - With no key: a **"Recommended: Groq"** card above the box: "Cheapest reliable result in
       Kept's test: about USD 0.004 a receipt. On the key tier Kept measured, Groq reads 2–3 photos a
       minute; Kept paces to it." A link to Groq's key page, and "Other providers" (OpenAI, Anthropic, Google,
       OpenRouter, custom) as equal choices below it.
     - A pasted Groq key selects `qwen/qwen3.8-27b` for photos, marked **Recommended**, with the
       reason on a "Why?" disclosure: the measured figures, that the test was synthetic and the
       evaluation re-checks it, and that Groq has no embeddings model, so semantic search needs
       another provider or stays keyword-only.
     - The Test result: ✓ photos ✓ structured answers, with the tokens and ≈ cost of the test
       itself ("Test used 2,700 tokens · ≈ USD 0.002").
     - After the first key: **"Set a monthly limit?"** with the suggested cap filled in (§3.5 of
       the engineering spec): **Set USD 5.00 a month** · No limit. Nothing is capped unless chosen.
  4. **Using**, per task: "Photos and receipts: Groq · qwen/qwen3.8-27b · from your account" ·
     "Assistant: …" · "Search: keyword only (no embeddings model)".
  5. **This month:** a bar per cap with "so far" (D188): "USD 1.12 of USD 5.00 · 22%", tokens,
     and "3 calls with unknown cost". A link to **AI usage**.
  6. **Advanced** (collapsed): provider kind and base URL; the **model picker** per task (D202:
     the Combobox, vision-capable models only for photos, "Refresh list", "Custom model id" for
     compatible servers only); reasoning effort; **caps** (below); the price table (read-only
     for owners, editable in Admin); "Pause AI".
  7. **What is sent to <provider>** (D83), beside the provider choice and on its own row:
     "Only a copy of the photo with location and camera data removed, never the original. The
     fixed instructions and your location's languages. For the assistant, your question and the
     inventory it looks up, within your role. Never secret fields." Then the provider's own terms,
     summarised with a date and a link to its policy.
- **Caps** (Advanced, and from the usage page): monthly money and/or tokens for the account;
  per location ("Home: USD 3.00 · inside the account's USD 5.00"); per person in the account
  ("Bruce: 200k tokens"); the per-task budgets (D19). Money and token fields are plain inputs;
  the currency is the Kept currency picker, never a native select. A location cap above the
  account's shows "can't be above the account's cap".
- **Members** see sections 1, 2 (as a status line: "AI here is paid by Alfred's account"), and their
  own "This month". **Viewers** see section 1 and the status line; money only where the location
  shows it to viewers.
- **States:** paused (the paused banner, below, at the top); a key rejected ("Groq rejected the
  key · Replace key"); a chosen model gone from the list (D202); offline (Test and Save disabled
  with the reason).

### AI usage (D206)
- **Purpose:** how much AI was used, what it cost, who paid, and every call.
- **Route and scopes:** `/settings/ai/usage?scope=…`, with a scope switch: **Me** (everyone) ·
  **<Location>** (its admins and owner, one per location) · **Account** (its owner) · and
  **Instance** at `/admin/ai/usage` (instance admins). The switch shows only the scopes you have.
- **Contents (phone, in order):**
  1. The period: This month (labelled **"so far"**, never compared with full months) · Last month
     · Last 3 months · Custom (Kept's calendar).
  2. **Totals:** calls (and how many were held back), tokens, images, cost per currency, "N calls
     with unknown cost", and the caps' progress bars.
  3. **Charts** (the design system's charts; a table alternative for each, §4): by **day**
     stacked by task; by **task**; by **model**; by **person** (location and account scopes); by
     **location** (account scope); by **account** (instance scope: totals only).
  4. **Outcomes:** ok · refused · rate-limited · over budget · provider error · timeout · invalid
     answer · cut off, each a count that filters the list.
  5. **The call list**, on the **filter strip** (D205): time, task, model, person, location,
     tokens, images, ≈ cost, outcome; tap a row for its detail sheet (every recorded field in
     plain words, its other attempts, and links to the extraction's thing or, for its owner only,
     the thread). Fields: date, person, location, task, model, provider, outcome, paid by, has
     image, tokens, cost (where money shows), thing. **Export CSV** exports the filtered list.
- **Instance scope:** per-account totals, and the list of calls the **instance key** paid, with
  the account and person but no location, thing or thread (D33).
- **Empty:** "No AI calls yet. Each captured photo will appear here with what it cost."
- **Money gate:** viewers see tokens; cost only where the location shows money to viewers.

### AI paused and waiting (D206)
- **Paused (a cap, a day budget, or by hand):** a banner, **"AI paused until 1 Oct · Home's
  monthly cap reached"**, on Capture (under the place chip: "Photos still save; naming waits"),
  the inbox, AI settings and usage, and as a row in Home's attention panel for whoever can resume.
  Drafts show "Waiting: AI paused until 1 Oct"; the assistant's composer is disabled with the same
  reason (§3); Search says "Semantic search paused · keyword results".
- **Resume now** (the cap's setter only) opens a sheet: "Home has used USD 5.00 of USD 5.00 this
  month · Raise to [6.25] · Remove the cap · Keep paused". Others see "Ask Alfred to resume".
- **Waiting for the provider** is not a pause and has no banner: progress lines say "Waiting for
  Groq · about 20 s". **Provider unavailable** says "Groq isn't answering · retrying at 14:05".
  **Key rejected** says "Groq rejected the key · Replace key" to managers and "AI isn't working
  here · ask Alfred" to others.

### Location settings → What to track (D61, D75, D113, D191)
- **Purpose:** choose what this location keeps track of, in outcomes rather than module names.
- **Entry:** Location settings; the new-location wizard's last step shows the same cards (§6).
- **Contents (phone, in order):**
  1. Three preset cards, **Essentials · Household · Complete**, each describing what you get:
     - Essentials: finding things: rooms, boxes, labels and search.
     - Household: adds receipts and warranties, reminders, lending, paperwork and **vehicles**
       (D191).
     - Complete: adds fuel, "Things you run out of", "Passwords and codes" and moving mode, and
       "Connect ChatGPT or Claude" (D191) rather than "MCP".
     - "Readings" isn't on any card: meters are core (D113).
  2. **Fine-tune:** one switch per module, named the same way, with its dependency shown (Fuel
     needs Vehicles).
  3. AI capture and the assistant: "On once an AI provider is connected", with a switch to turn
     them off in this location (D191).
- **Primary action:** Save. Switching preset first lists what turns on and off; turning a module off
  hides it and **never deletes data** (D61).
- **States:** a module that's off shows as **"Off in this location"** wherever it would appear,
  with "Turn on" for admins and "Ask an admin" for others (§3).
- **Variants:** owner and admins only. The Personal location starts on Household.

### Members and roles (D46, D48, D180)
- **Purpose:** who can see this location, and what each person can do.
- **Entry:** the location page → Members; Location settings → Members (owner and admins). Members
  and viewers don't open it; they have Leave this location on the location page.
- **Contents:**
  - Grouped by role: **Owner · Admins · Members · Viewers**, then pending invites (with their
    expiry and Revoke).
  - Each row: name, role, and "until 12 Oct" for an **expiring membership** (D46); managed accounts
    are marked (D47).
  - Phone: a list; a row opens a sheet with its actions. Desktop: a table with the actions inline.
- **Row actions:** change role; set or clear the end date (no later than your own, D180); remove.
  Promoting, demoting or removing admins is **owner only** (D48). The owner's row has no actions;
  transfer lives in Location settings.
- **Primary action:** Invite.
- **Leave this location:** at the bottom for admins, members and viewers, never the owner. The
  confirm sheet says the person's webhooks, share links and exports for this location stop working
  (D180).
- **States:** on its end date an expiring membership stops working, its tokens are revoked, and the
  owner is notified (D46). The Personal location has no Members screen (D114).

### Invite (D33, D181, D193)
- **Purpose:** get someone into this location without needing email.
- **Entry:** Members → Invite; the "Invite people" card on Home after a location is created (D194);
  the Get-started checklist.
- **Contents (phone, in order):**
  1. **Role picker:** only roles you may grant (admin only for the owner, D48).
  2. **Expiry picker:** no end date, or a date, capped at your own end date (D180).
  3. The link, with **Copy link** and a **QR code** beside it, so the other phone scans it directly
     with no SMTP (D193). The link is valid 7 days and single-use (D33, D184).
  4. Send by email: shown when SMTP is set up; otherwise disabled with the reason or the setup link
     (§3).
- **Primary action:** Copy link.
- **States:** the pending invite appears under Members, where it can be revoked.

### Accept invite (D127, D181, D190)
- **Purpose:** join a location from a link or QR code.
- **Entry:** `/invite#<token>`; the token stays in the fragment and is consumed by POST (D181).
- **Contents (phone):**
  - The location's name, kind and cover photo if it has one (D195); who invited you; the role and
    any end date ("Viewer until 12 Oct").
  - Signed in: **Join <location>**. Not signed in: sign in, or create an account, the only way in
    while sign-up is closed (D33, D127). The invite is consumed in the same step that sets up the
    new account (D190).
- **Primary action:** Join.
- **States:** expired, used or revoked: "This invite no longer works. Ask <inviter> for a new one."
  Already a member: opens the location. The location requires two-factor and the person hasn't
  enrolled: they join, and the location stays hidden until they add a passkey or an authenticator
  (D190).

### Other screens
- **Trash:** restore (members and above); delete permanently (admins and above).
- **Incidents and claims:** multi-select things → "Add to incident". A claim prefills the
  longest active warranty and shows the brand's claim URL and contact.
- **Reports:** insurance, vehicle history, box contents, claim pack (D158).
- **Consumables:** low stock, with Adjust.
- **Expiring:** things, documents and warranties by date.
- **Person page:** what they have, and what belongs to them (D57).
- **Condition reports (1.x):** per room, dated photos (D171).
- **Share links:**
  - Expiry presets up to a maximum of 1 year.
  - "Preview as recipient", with the photo chosen by the sharer.
  - A views count.
  - The page language follows the viewer's browser.
- **Moving board (1.x):** boxes by state; destination room per box, printed on its sheet;
  unpacking moves the contents to the destination.
- **Split household (1.x):** an admin in both locations; the selection's containers move whole
  or are split by choice; shared purchases are copied (D161).
- **Notification centre:** grouped by kind, with inline actions: complete, snooze to a date or a
  meter value, mark returned.
- **Activity feed:** filter by person, kind and date; undo from an entry (D150).

### The filter strip (D205)

Every list screen uses the same filter strip instead of its own chips:

- **Layout:** `[pinned view tabs…]` above `[search box] [active filter chips…] [+ Filter] [Views ▾] [⇅ Display]`. Only
  filters in use show as chips; a chip reads "Person: Alfred, Bruce" ("Person: not Alfred" for "is none of") and has ×
  to remove it. "Clear all" appears with two or more chips. Chips and their text wrap; nothing is cut off.
- **+ Filter:** a menu of the list's fields, fuzzy-searchable when there are more than five (Arabic-aware, typos
  of one letter forgiven in words of four letters or more). Picking one opens its editor in the same popover, with
  Back to the fields. An on/off field (a location's Unplaced) switches on straight from the menu.
- **A field's editor:** fuzzy search over its values, multi-select with checkboxes, an "is any of / is none of"
  switch, and "Only this" on each row (on hover or focus on desktop, always on phones). What was chosen when the
  editor opened leads the list; rows don't move as you tick them. People (belongs to), brands and tags are searched
  on the server as you type (the registry routes' `q`); types, places and the people who acted in a location are
  loaded whole and matched here. Dates: Today · Last 7 days · Last 30 days · This year · Custom range (Kept's
  calendar). A price range takes a lowest and highest amount and a currency, only for readers who can see money.
- **Changes apply at once:** the list behind updates as you tick. The first change while an editor is open adds a
  history entry and the rest replace it, so Back undoes the whole edit. State is in the URL: `f.<key>` for values,
  `not` for the "is none of" filters, `saved=<id>` for the view it was opened from, and the Display button's `sort`,
  `dir`, `group` and `view`. A saved view keeps all of them.
- **The Display button (D211):** the list's view options (sort, the sort's direction, grouping, and a layout where
  the list has one) live behind one compact button at the end of the strip's row, after + Filter and Views, in their
  size and style: an arrows-up-down icon and a label naming the current state: "Name", "Name · by type" when grouped,
  "Changed · photos" when the layout isn't the default. It opens a menu (a popover on desktop, a bottom sheet with
  Done on phones): a small **Sort** heading and the sorts with a check mark on the current one; under them the
  direction switch, **A to Z / Z to A** for a text sort and **Newest first / Oldest first** for a date sort
  (changed, last seen, created); a divider, a **Group** heading and the groupings with a check mark, when the list
  groups; a **Layout** heading (List · Photos on a container's contents), when the list has layouts. Choosing
  applies at once and the menu stays open; a new kind of sort starts at its own direction. There are no "Group by" or
  "Sort by" bars and no second toolbar row: a list's secondary view options never take a row of their own (forms and
  settings keep their segmented controls, which are choices, not view options). State is in the URL (`sort`, `dir`,
  `group`, `view`); choosing a list's default writes nothing. Keyboard: Enter or Space opens it, arrows move, Enter or
  Space chooses, Escape closes and focus returns to the button. Its accessible name says the state ("Display options:
  sorted by Name, A to Z, by type"). On a narrow phone the label keeps the icon and the sort's name; it is never cut
  short with ….
- **Saved views:** Views ▾ lists the list's views (yours and those shared with your locations): open, pin as a tab,
  open this list with it (the default), delete (your own; a location's admins may delete its shared ones). "Save
  view" names the current filters, chooses who sees it (you, or everyone in a location where you may share), and can
  pin it and make it the default. Pins and the default are yours alone, whoever made the view. The default opens
  when you come to the list with nothing in its URL; a link with filters wins. A changed view shows "You changed
  <name>" with **Save changes** (your own views only) · **Save as new** · Undo changes; the "All" tab clears.
- **Phones:** "Filters (n)" opens a bottom sheet with the same fields and editors, and Done; Views ▾ and Display
  sit beside it on the same row, which never wraps at 375 px; applied filters show as chips that wrap.
- **Keyboard:** `/` search · `F` + Filter · Backspace in an empty search box removes the last chip · arrows (and
  Home/End) move between chips, mirrored in RTL · Escape closes a popover without clearing what was ticked.
- **Lists and their fields:** Activity (person, kind, date, location) · Search (location, place, type, tag, state,
  price for money-visible readers) · Trash (kind, location, deleted by, date) · a person's, brand's or vendor's
  things (location, type, tag, state, brand, belongs to; not the page's own) · place contents (Unplaced on a
  location, type, tag, state, brand, belongs to) · later Inbox (kind, location, mine) and admin lists. Small lists
  (a thing's paperwork, admin currencies) use the same strip with their one field.

## 6. Flows

- **Field-level conflict (D156):**
  - A three-way merge: fields only they changed merge silently; only fields both people changed
    are listed, with keep mine, keep theirs, or edit.
  - In the spreadsheet, rows without conflicts save; conflicted rows stay staged with a marker.
- **Carrying tray (scan-to-move):**
  - Select or scan things to pick them up ("Carrying 5"), then scan or choose the destination.
  - The tray persists offline.
- **Box check (D40):**
  - Checkboxes, with a count stepper for quantity rows ("found 4 of 6"); nested containers collapsed.
  - "Found something else" moves it in.
  - Anything unticked becomes *not here*.
  - Works offline (queue op `box_check`).
- **Label printing:**
  - Choose stock → layout preview → **start cell** on a partly used sheet → print (print-styled
    HTML with `@page` sizes, D185) → "Printed OK?" sets `printed_at`.
  - Things with a pending ID are excluded.
- **First run (instance, 3 steps):** setup code → first account → instance options (sign-up,
  barcode lookup D126, AI now or later) → **Finish setup**.
  - The recovery-kit acknowledgement (D66) no longer blocks Finish setup. It is asked for at the
    first of: adding a secret value, adding an AI key, or configuring backups; until then the
    status page asks for it (D193).
  - If `KEPT_SECRET_KEY` or `KEPT_AUTH_SECRET` was unset, the container generated both into the
    config volume and logged one line saying where; the recovery kit is how the admin keeps a
    copy off the server (D193).
- **New location (3 steps, skippable after the name, D194):** name and kind → rooms ("Add room or
  spot", with the template's rooms filled in) → what to track (the preset cards, §5).
  - The last step shows the timezone and currency taken from the browser and locale; both are
    editable in Location settings.
  - Aliases and languages are set in Location settings. Inviting people is a Home card after
    creation (§5 Home), not a step.
- **Import stepper:**
  - Steps: source → collection → location mapping (new or existing) → dry-run choices (D146) →
    per-row report → progress → a summary linking to the imported things.
  - CSV place-path columns ("Garage > Shelf A") create places.
- **Quick log:** "Log a reading" from Home and from the vehicle. "Log a service" (§5) ticks off the
  schedules its line items complete. The lend and return sheets take a partial quantity and condition photos.

## 7. Form validation

Messages sit next to their field and are announced (WCAG 4.1.3). Lengths are in characters.

| Form | Rules |
|---|---|
| Thing | Name 1–200 (optional only while a draft); notes ≤ 5,000; quantity ≥ 0 (> 0 unless consumable); a price needs a currency; serial and IMEI ≤ 100 |
| Place / location | Name 1–120; timezone from the IANA list; currency from enabled currencies |
| Purchase | Date not in the future; total ≥ 0 with currency; line totals reconcile ±1% or flag |
| Warranty | End ≥ start, or a term, or lifetime (exactly one) |
| Loan | Due ≥ start; partial quantity ≤ available |
| Schedule | At least one of: interval in units, interval in months, a one-off due date |
| Reading | Numeric ≥ 0; checked against neighbours (D112) |
| Fuel | Amount > 0; cost ≥ 0 with currency |
| Membership | Expiry in the future and no later than the inviting admin's own expiry (D180) |
| Share link | Expiry ≤ 1 year |
| Token | Name 1–80; locations ≥ 1 by default (D179) |
| Type field | Key unique within the type and its ancestors; kind changes only through "convert with preview" |

## 8. Resolved during the design pass (D189)

Questions the five screen designers raised while drawing, and their answers.

**Home and onboarding**
- **Empty Home:** every user always has a Personal location (D114), so Home is never truly empty. The first-run state shows the Personal card plus **"Create your first home"**.
- **Recent activity:** 3 items on the phone, 5 on desktop.
- **Attention panel:** zero-count rows are hidden. Rows appear in a fixed order: to review · overdue · due · expiring · lent out · borrowed in · uncertain · long unseen · Unplaced · low stock.
- **Get-started checklist:** it can be restored from Help. "Install on your phone" completes when Kept is opened in standalone display mode. In the first-run state the checklist is hidden, because its first item would duplicate the main button.
- **Capture with no location:** capture goes to the Personal location's Unplaced area.
- **Setup code:** 6 Crockford base32 characters. It is logged as `KEPT SETUP CODE: XXXXXX` and re-issued with `kept admin setup-code`.
- **Recovery kit at first run:** its acknowledgement no longer blocks Finish setup (D193, §6). It can't contain backup credentials yet, because backups aren't set up. When backups are configured, the status page asks the admin to download the kit again. `kept admin recovery-kit` produces it. Downloading in the web UI requires re-authentication even right after sign-up.
- **Location templates:**
  - *Apartment*: living room, kitchen, 2 bedrooms, bathroom, balcony.
  - *House*: adds a second floor, a hallway and a storage room.
  - *Garage*: tool wall, shelves, floor.
  - *Storage unit*: front, back, shelves.
  - **Household** is the recommended preset. Skipping rooms leaves only Unplaced.

**Browse and things**
- **Box check leftovers:** "found 2 of 3" splits the row (D10). The found part stays; the missing part becomes a new row marked *not here*.
- **In repair:** a thing that's in repair shows "Usually in <place>" under its derived state.
- **Actions that don't apply** (Split on quantity 1, Lend while lent or in repair) are **hidden**. This extends the §3 rule: *not applicable* means hidden.
- **Focused tasks:** box check, capture and the carrying tray are focused tasks and replace the tab bar with their own footer.
- **Copying a revealed secret** is allowed and is logged as *copied*.
- **Labels for things captured offline:** after sync, a **"Print pending labels (N)"** prompt appears.
- **Location vs place naming:** examples follow D5. Garage and Storage unit are locations of their own; the board's sample path is corrected to match.

**Capture, inbox and scanning**
- **"$" on a receipt:** it has **no preselection**. The person picks USD or CAD, so the ambiguity isn't hidden behind a default. This replaces D136's "defaults to the location's currency".
- **Scan outcomes** include Homebox labels, with a collection picker when an asset ID is ambiguous (D146, engineering spec §2.4).
- **Inbox keys:** `l` link a receipt line · `s` split · `g` merge · `d` drop · `y`/`n` confirm or reject the focused Suggested field.
- **Place suggestion (D153):** the chip shows the last place used in the nearby location, otherwise its Unplaced area.
- **Receipt pages:** in Receipt mode, "+ photo to this thing" adds a page to the same receipt.
- **Offline inbox:** reviewing needs a connection. Drafts not yet synced appear as "On this phone · waiting to sync", read-only.
- **Inbox scope:** it follows §1. It is global, with a location filter chip; the default filter is *Mine*.

**Search, assistant and notifications**
- **Activity:** added to **More** and the sidebar.
- **Undo from the activity feed:** secret changes can't be undone there. A capture batch can be undone as a whole: its unreviewed drafts go to the trash.
- **Assistant conflicts:** a card-level conflict offers **Ask again** or **Cancel**; Confirm is unavailable.
- **Snoozing:** snooze-to-meter defaults to **+10% of the schedule's interval** (1,000 km on a 10,000 km schedule).
- **Context chip:** on the phone it sits in the assistant sheet's header.
- **Search results:** a result matched through an alias shows "matched: display cable".
- **Arabic search:** it also strips the definite article "ال" and common attached prefixes (و، ب، ل، ف) at index and query time (extends D42), with test vectors.
- **Offline search:** documents show a placeholder group, "Documents need a connection".
- **Viewers asking for a change:** the assistant answers "Viewers can't make changes here. Ask an admin of Home", with no card.

**Vehicles, settings and admin**
- **Vehicle detail:** a vehicle is a thing, so its route is `/t/<id>`. Vehicle sections become tabs: Overview · Readings · Services · Fuel · Schedules · Documents · Costs. `/vehicles` is the list.
- **MCP:** the endpoint is **`/mcp`** on the public URL (added to §2).
- **Digits (D143):** readings, amounts, dates and counts follow the digit setting. Short IDs, serials, VINs, codes and licence plates are shown **as printed**, so an Egyptian plate keeps its Arabic letters and digits. In Arabic with Eastern digits the board reads "٥٢٬٣٤٠ كم" and "٤٬٥٠٠ ج.م."; the ID and VIN stay Western and left-to-right. This section wins over any frame that disagrees.
- **Reading age:** a reading 30 days old or more shows **advice** ("reading is 34 days old", D52). From 60 days the estimate becomes **unknown** (D188).
- **Reminders:** the scan runs every **15 minutes**, and **"not scanned" alarms after 2 hours**. The default lead time for a licence or document reminder is **30 days**.
- **AI usage:** instance embeddings (search) show as a separate "Instance · search embeddings" line in usage.
- **Provider data-use notes** are checked against each provider's current terms before release (§19).

## 9. Final review resolutions (D190–D196)

What the final pre-build review changed on these screens. The decisions are in the
[product design](2026-09-25-kept-product-design.md) log; where a row here and the log disagree,
the log wins.

| Decision | On these screens |
|---|---|
| **D190** Build-start answers | Location settings: require two-factor counts a passkey with user verification, and hides the location from members who haven't enrolled. Accept invite: the invite is consumed in the step that sets up the account. The setup code stays 6 characters (§8). |
| **D191** Presets re-cut | What to track (§5): outcome copy on the cards, Vehicles in Household, AI capture and the assistant on in any preset once a provider is connected. Home: no AI setup items on Essentials until a provider is connected or AI settings are opened. Inbox: zero-count chips hidden. AI settings: "Paste your key → Test" first, the rest under Advanced. |
| **D192** Smart-device fields | Type editor: the Device field group. |
| **D193** First run without walls | Home: "Put Kept on HTTPS" first over plain HTTP. Invite: a QR code beside Copy link. First run (§6): 3 steps; the recovery-kit acknowledgement moves to the first secret value, AI key or backup setup, and the status page asks for it meanwhile. |
| **D194** The first capture is findable | New location (§6): 3 steps; inviting becomes a Home card. Capture: the room grid on the first capture into a new home, Name as the primary input when AI is off, "Naming…" drafts findable by place and photo. Search: the D74 test. |
| **D195** Small delights | Container photo beside the path in Search and the assistant; the ID chip's tape animation; shutter thumbnails in the place chip; the odometer proof strip; the warranty coverage bar and "Warranty saved you"; location cover photos; the photo grid on a scanned box. |
| **D196** Receipt camera copy | Capture, Receipt mode: "Hold steady · fill the frame"; no "Edges found"; the server crops. |

**New screens specified here** for the People and types frames on the screens board: Personal
location, A viewer's thing detail, Log a service, What to track, Members and roles, Invite, Accept
invite, and the Type editor's identity, icon, field list and Device group.

**Coherence fixes applied here:** the offline row in §4 (never secrets or contact details); the
first-run Home state; the attention-panel order (overdue · due); recent activity 3 / 5; "borrowed"
in derived states; viewers get Copy link only and no Mark seen; Lend hidden while in repair; place
kinds under Account settings; the personal-key note (D167); the sidebar entries; Eastern digits
on the board (§8); "Room or spot" for adding a place (product design §6.2).

**Left open for the maintainer, not applied:** calling Personal "On me" and hiding it until used;
dropping the word "location" in the UI in favour of the kind (home, garage, storage).

## 10. Additions after the final review

Decided after §9, on the maintainer's requests of 2026-09-26. The decisions are in the
[product design](2026-09-25-kept-product-design.md) log; where a row here and the log disagree,
the log wins.

| Decision | On these screens |
|---|---|
| **D198** The icon rail | The desktop frame (§1): the sidebar folds to a rail with tooltips, badges and a pinned toggle; the top bar's search and Capture become icon buttons at 768–1023 px. |
| **D201** The inventory report | Location page and Settings → Account: "Print inventory" opens a filter sheet (places, types, tags, ended and trashed), then shows progress and a download. |
| **D202** The model picker | AI settings: provider kinds including OpenRouter and Groq; models picked from the provider's list, split into vision and text; a flag when a chosen model disappears (also on the admin status page). |
| **D203** Content width | Settings → Me → Display: Centered or Full width (segmented control, from 768 px). Full width widens list pages (Home, Location, Place, Activity, Search, Trash, Account registries, Admin); text and forms keep their widths. |
| **D204** Languages, theme, digits | Settings → Me → Display: the language dropdown with flags (five languages), System/Light/Dark with System first, digits only in Arabic; the sign-in pages' language picker; Location settings → General: the languages multi-select. |
| **D206** AI keys, usage and spend | AI settings (§5): "What uses AI in Kept" first, where the key lives, the recommended Groq card and pre-selected `qwen/qwen3.8-27b`, a suggested monthly limit, caps, what is sent to each provider. New: AI usage per scope with charts, the call list on the filter strip and CSV export (§2 routes). The paused banner and "Resume now"; waiting for the provider shown on progress lines only (§3). The AI line on AI-filled drafts (Inbox); AI calls in a thing's History; Location settings gain "AI here"; Me gains "My AI usage"; Admin → AI gains instance caps and the versioned price table. |
| **D211** The Display button | Every list's filter strip (§5 "The filter strip"): sort, direction, grouping and a container's list or photos behind one button at the end of the strip's row, a menu on desktop and a bottom sheet on phones; the Group by / Sort by bars are gone. |
