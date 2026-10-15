---
title: Dashboards
description: Kept's counts on a dashboard. Copy-paste widgets for Homepage, Glance and Homarr that read what is overdue, due and expiring from Kept's summary.
---

A dashboard can show what needs you in Kept: overdue, due, expiring, lent out, uncertain and low
stock, in total and per location. Each widget below reads one call,
`GET /api/v1/summary`, with a [personal token](/users/mcp-clients/#make-a-personal-token)
(**Read only**, the locations you want counted). [Home Assistant](/users/home-assistant/) reads
the same call.

## The summary

```json
{
  "asOf": "2026-10-15T11:30:00.000Z",
  "totals": { "things": 61, "unplaced": 4, "overdue": 2, "due": 3, "expiring": 2,
              "lentOut": 2, "borrowedIn": 0, "uncertain": 2, "longUnseen": 0, "lowStock": 0 },
  "locations": [
    { "id": "…", "name": "Home", "kind": "home", "timeZone": "Africa/Cairo",
      "counts": { "things": 34, "unplaced": 1, "overdue": 2, "due": 1, "expiring": 1,
                  "lentOut": 1, "borrowedIn": 0, "uncertain": 1, "longUnseen": 0,
                  "lowStock": null } }
  ]
}
```

- Each count is the one on Kept's Home, for the locations the token reaches.
- `null` in a location: that module is off there (Lending for `lentOut` and `borrowedIn`,
  Consumables for `lowStock`). `totals` add up the locations where it applies, so they are
  always numbers.
- No names of things, no money.

Keep the token in the dashboard's secrets, not in a file you share. Each example uses
`https://kept.example.org`: put your Kept's address.

## Homepage

A [Custom API](https://gethomepage.dev/widgets/services/customapi/) widget, in
`services.yaml`. The token comes from an environment variable, `HOMEPAGE_VAR_KEPT_TOKEN`
([environment secrets](https://gethomepage.dev/installation/docker/#using-environment-secrets)).
Checked against Homepage 2.5.0's docs.

```yaml
- Home:
    - Kept:
        href: https://kept.example.org
        description: What needs you
        widget:
          type: customapi
          url: https://kept.example.org/api/v1/summary
          refreshInterval: 300000 # 5 minutes
          headers:
            Authorization: Bearer {{HOMEPAGE_VAR_KEPT_TOKEN}}
          mappings:
            - field: totals.overdue
              label: Overdue
              format: number
            - field: totals.due
              label: Due
              format: number
            - field: totals.expiring
              label: Expiring
              format: number
            - field: totals.lowStock
              label: Low stock
              format: number
```

Per location instead, one row each:

```yaml
        widget:
          type: customapi
          url: https://kept.example.org/api/v1/summary
          refreshInterval: 300000
          headers:
            Authorization: Bearer {{HOMEPAGE_VAR_KEPT_TOKEN}}
          display: dynamic-list
          mappings:
            items: locations
            name: name
            label: counts.overdue
```

## Glance

A [`custom-api`](https://github.com/glanceapp/glance/blob/main/docs/configuration.md#custom-api)
widget, in `glance.yml`. `${KEPT_TOKEN}` is read from Glance's environment. Checked against
Glance 0.8.6's docs.

```yaml
- type: custom-api
  title: Kept
  cache: 5m
  url: https://kept.example.org/api/v1/summary
  headers:
    Authorization: Bearer ${KEPT_TOKEN}
    Accept: application/json
  template: |
    <div class="flex justify-between text-center">
      <div>
        <div class="color-highlight size-h3">{{ .JSON.Int "totals.overdue" }}</div>
        <div class="size-h6">OVERDUE</div>
      </div>
      <div>
        <div class="color-highlight size-h3">{{ .JSON.Int "totals.due" }}</div>
        <div class="size-h6">DUE</div>
      </div>
      <div>
        <div class="color-highlight size-h3">{{ .JSON.Int "totals.expiring" }}</div>
        <div class="size-h6">EXPIRING</div>
      </div>
      <div>
        <div class="color-highlight size-h3">{{ .JSON.Int "totals.lowStock" }}</div>
        <div class="size-h6">LOW STOCK</div>
      </div>
    </div>
    <ul class="list list-gap-10" style="margin-top: 1rem">
    {{ range .JSON.Array "locations" }}
      <li>{{ .String "name" }}: {{ .Int "counts.overdue" }} overdue, {{ .Int "counts.due" }} due</li>
    {{ end }}
    </ul>
```

Add `allow-insecure: true` for a self-signed certificate.

## Homarr

A custom widget (Homarr 2.x). Save the definition below as `kept.homarr-widget.json`, then in
Homarr: **Custom widgets → Import**. In **Configure API sources**, put your Kept's address in place
of the suggested one, tick the confirmation, and paste the token into **API key or token**. Then
add it to a board: **Choose item to add → Custom widget**. Homarr calls Kept from its server and
keeps the token out of the browser.

Checked against Homarr 2.5.2's import schema, not yet run through its preview: use **Test and
preview** before you rely on it.

- `networkScope: private` lets Homarr reach Kept on your LAN. Homarr refuses Tailscale's
  `100.x` addresses under every setting, and doesn't follow redirects: use Kept's LAN address,
  the final one.
- A self-signed certificate is likely refused; use a trusted one or `http://` on your LAN.

```json
{
  "$schema": "homarr-custom-widget-v2",
  "name": "Kept",
  "description": "Overdue, due, expiring, lent out, uncertain and low stock from Kept.",
  "sources": {
    "default": {
      "name": "Kept",
      "baseUrl": "https://your-kept.example.com",
      "networkScope": "private",
      "auth": "bearer"
    }
  },
  "requests": {
    "summary": {
      "path": "/api/v1/summary",
      "cacheSeconds": 60
    }
  },
  "options": {
    "showLocations": {
      "label": "Show each location",
      "control": "switch",
      "default": true
    }
  },
  "template": "<Stack gap=\"sm\" p=\"sm\" h=\"100%\" style={{ minWidth: 0, minHeight: 0 }}>\n  <Group justify=\"space-between\" wrap=\"nowrap\"><Text size=\"xs\" c=\"dimmed\" tt=\"uppercase\" fw={700}>Kept</Text><RefreshButton requestId=\"summary\" label=\"Refresh\" size=\"xs\" /></Group>\n  {status.summary?.loading && <Skeleton height={120} radius=\"md\" />}\n  {status.summary?.ok === false && <Alert color=\"red\" title=\"Kept unavailable\">{status.summary.error || \"Check the address and token under Configure sources.\"}</Alert>}\n  {!status.summary?.loading && status.summary?.ok !== false && <ScrollArea style={{ flex: 1, minHeight: 0 }}><Stack gap=\"sm\">\n    <SimpleGrid type=\"container\" cols={{ base: 2, \"300px\": 3 }} spacing=\"xs\">{[{ label: \"Overdue\", value: data.summary?.totals?.overdue }, { label: \"Due\", value: data.summary?.totals?.due }, { label: \"Expiring\", value: data.summary?.totals?.expiring }, { label: \"Lent out\", value: data.summary?.totals?.lentOut }, { label: \"Uncertain\", value: data.summary?.totals?.uncertain }, { label: \"Low stock\", value: data.summary?.totals?.lowStock }].map(item => <Paper key={item.label} withBorder radius=\"md\" p=\"sm\"><Text size=\"xs\" c=\"dimmed\">{item.label}</Text><Text fw={700} size=\"xl\">{item.value ?? \"-\"}</Text></Paper>)}</SimpleGrid>\n    {options.showLocations && <Stack gap={0}>{(data.summary?.locations ?? []).map(location => <Group key={location.id} justify=\"space-between\" wrap=\"wrap\" gap=\"xs\" py=\"xs\"><Text size=\"sm\" fw={600}>{location.name}</Text><Text size=\"xs\" c=\"dimmed\">{\"Overdue \" + location.counts.overdue + \" \u00b7 Due \" + location.counts.due}</Text></Group>)}</Stack>}\n  </Stack></ScrollArea>}\n</Stack>"
}
```
