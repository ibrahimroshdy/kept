---
title: Home Assistant
description: Kept in Home Assistant. Sensors for what is overdue, due and expiring in each location, each vehicle's reading and next service, a calendar, and actions that send a car's odometer to Kept.
---

The Kept integration for [Home Assistant](https://www.home-assistant.io/) shows what needs you in
each location and sends readings back, such as the odometer a car integration already knows. It
reads Kept with a [personal token](/users/mcp-clients/#make-a-personal-token).

The integration: [keptinventory/kept-homeassistant](https://github.com/keptinventory/kept-homeassistant),
installed with [HACS](https://hacs.xyz/) as a custom repository. Needs Home Assistant 2026.10 or
later and Kept 1.8.0 or later.

## What you get

Each location is a device in Home Assistant:

| Entity | What it shows |
|---|---|
| **Overdue**, **Due**, **Expiring** | The counts on Kept's Home. The `items` attribute lists the first 10, most urgent first |
| **Lent out**, **Borrowed in** | Open loans. Only where Lending is on |
| **Uncertain**, **Long unseen** | Things whose place is in doubt, or not seen for the location's months |
| **Low stock** | Things below their minimum. Only where Consumables is on |
| **Unplaced**, **Things** | Off at first; turn them on in Home Assistant |
| **Due dates** (calendar) | Every item with a due day, as an all-day event |

Each vehicle (a thing with a meter, under **Vehicles**) is a device in its location:

| Entity | What it shows |
|---|---|
| **Reading** | The latest reading, in km, mi or hours |
| **Next service** | The day it's due, or Kept's estimate from your readings |
| **Next service at** | The reading it's due at |

A location or vehicle added in Kept later shows up after you reload the integration.

## Set up

1. **Make a token.** In Kept, **Settings → Connections → New token**. Tick the locations Home
   Assistant should see. **Read only** is enough for the sensors and the calendar; **Read and
   change** also lets the actions below send readings and mark schedules done. Kept makes tokens
   only when it is served over `https` ([HTTPS](/install/https/)).
2. **Install.** In HACS, **⋮ → Custom repositories**: add
   `https://github.com/keptinventory/kept-homeassistant`, type **Integration**. Install **Kept**,
   and restart Home Assistant.
3. **Add it.** **Settings → Devices & services → Add integration → Kept**. Enter Kept's address
   (`https://kept.example.org`) and the token. Turn off **Check the HTTPS certificate** only for a
   self-signed certificate on your own network.
4. **Check.** The next step names your Kept's version and the locations the token reaches.
   **Submit** adds them.

What the setup tells you when something is wrong:

| Message | What to do |
|---|---|
| Kept can't be reached | Check the address and that Home Assistant can reach that host |
| It isn't Kept | The address answers, but with something else: a proxy's page, another app |
| That address redirects to HTTPS | Use the `https://` address it names |
| The HTTPS certificate isn't trusted | Use a trusted certificate, or turn off the check for a self-signed one |
| HTTPS failed | Kept is served over plain `http` on that port: use `http://` |
| Kept refused the token | It was revoked, has expired or was mistyped: make a new one |
| This Kept doesn't offer the summary | Update Kept |

**Configure** on the integration chooses which of the token's locations to show and how often to
read Kept (every 5 minutes; 1 to 60). When the token is revoked or expires, Home Assistant asks for
a new one.

## Actions

**Kept: Log a reading** (`kept.log_reading`) sends a reading for a vehicle (or a meter, by its id:
the **Reading** sensor's `meter_id`). It shows in Kept as a reading from Home Assistant. Kept
refuses a reading lower than the one before it, and the action fails with Kept's reason; a jump
Kept finds unlikely waits for review in the Inbox.

**Kept: Mark a schedule done** (`kept.complete_schedule`) marks a schedule done on a day (today,
in the location's time zone) and records the service, with the reading for a schedule by meter.

Both need a **Read and change** token.

### The car's odometer, sent to Kept

When the car's odometer has settled for 10 minutes (the car is parked):

```yaml
alias: Odometer to Kept
triggers:
  - trigger: state
    entity_id: sensor.my_car_odometer
    for: "00:10:00"
conditions:
  - condition: template
    value_template: "{{ trigger.to_state.state | is_number }}"
actions:
  - action: kept.log_reading
    data:
      device_id: YOUR_KEPT_VEHICLE_DEVICE_ID
      value: "{{ trigger.to_state.state | float }}"
mode: queued
```

`sensor.my_car_odometer` is your car integration's sensor. In the automation editor, pick the
Kept vehicle in the action's **Vehicle** field to fill `device_id`. Send the reading in the unit
of the vehicle's meter in Kept.

## What it reads

Every few minutes, with the token: `GET /api/v1/summary` (the counts per location),
`GET /api/v1/vehicles` and the first page of `GET /api/v1/agenda`. The calendar reads
`GET /api/v1/agenda` for the days it shows. The actions use `POST /api/v1/meters/{id}/readings`
and `POST /api/v1/schedules/{id}/complete`. A token sees only its own locations, and never more
than you can. The same summary feeds [dashboard widgets](/users/dashboards/).
