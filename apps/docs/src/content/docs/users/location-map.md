---
title: The location map
description: See a location as a 3D map of its floors and rooms, find where things are, and arrange the rooms, shelves and boxes yourself.
---

A location's page has three layouts: **List**, **Grid** and **Map**. The map draws the location
in 3D: each floor, its rooms, and the shelves, cupboards and boxes in them. Tap anything to see
what it is, where it is and what's inside. List stays the default; Kept remembers your choice for
each location on each device. In Map, the map leads and fills the screen; the location's
buttons (Print inventory, Print labels and the rest), **Add here** and **Unplaced** follow it.

![A home on its map: rooms with their floors and walls, a TV unit selected with its card showing Inside · 5 and Details, the List · Grid · Map switch at the top](../../../assets/screens/map-desktop-light.webp)

![The same home on the map in the dark theme](../../../assets/screens/map-desktop-dark.webp)

The map needs a connection: it isn't part of the phone's offline copy. It loads only when you open
it, so the rest of Kept stays as quick as before.

## What's on the map

| On the map | Where it comes from |
|---|---|
| **Floors** | Places of the kind **Floor** at the top of the location. With none, the location is one level. |
| **Rooms** | Every place directly on a floor (or at the top, when there are no floors), whatever its kind. |
| **Shelves, cupboards, areas** | The places directly in a room. |
| **Boxes and other containers** | The containers directly in a room. |
| **Anything else** | A thing you put on the map yourself, such as the TV or the car. |

Names never overlap or get cut off: when two would touch, the room's name stays and what's in a
shelf or box shows once you zoom in far enough. The thing you selected always keeps its name.

Everything else is counted: a shelf says how many things are on it, and its card lists them.
Nobody has to arrange anything first. Rooms nobody arranged are laid out side by side in the
order of the places list, and what stands in them in rows. A room called "Garden", "Balcony" or
"Terrace" is drawn as one.

Pins show what needs attention: **Low stock** (Consumables), **Lent out** (Lending) and **Due soon**
(schedules, warranties and documents). A pin sits on the shelf or box that holds the thing. The
chips at the top turn each kind on or off.

## Moving around

| | With a mouse | On a phone |
|---|---|---|
| Pan | Drag | Drag with one finger |
| Zoom | Scroll, or **+** and **−** | Pinch, or **+** and **−** |
| Turn | The turn buttons | Turn with two fingers, or the turn button |
| Open a room | Double-click it, or **Open** on its card | Double-tap it, or **Open** |
| Back | The location's name or the floor at the top, or the house button | The same |

The floor buttons work like a lift: **R**, **1**, **G** and so on, each named after its floor, and
**All** stacks every floor. On a phone they sit in one row at the bottom with the zoom and turn
buttons, and step aside while a card is open. **Plan** looks straight down, with names and what's
in each shelf. Stairs on the map take you to the floor above or below.

![Plan: the same home seen from above, each room named](../../../assets/screens/map-plan-light.webp)

![The map on a phone: the List · Grid · Map switch, the 3D and Plan buttons, and a selected thing's card at the bottom](../../../assets/screens/map-phone-light.webp)

## The card

Tapping something opens a short card: its name, where it is, its short ID and anything due.
**Details** adds its photo, its label (the same QR code a printed label carries), its facts and
**Open the thing** or **Open the place**. **Inside** lists what's in it; tap one to see it. With a
mouse, hovering shows the name and short ID without a click.

## What's in the location

Under the map, **What's in** lists every room with what stands and lies in it. Search by name or
short ID, pick a floor, or switch to **Needs attention** for everything low, lent out or due. A tap
shows it on the map. The search, the floor and the view are in the address, so you can share or
bookmark them.

For screen readers and keyboards, **Places on this level** lists the floor's rooms and what stands
in them, beside the map.

## Arranging

Owners, admins and members can arrange a location; viewers see it as arranged. **Arrange** starts:

- **Move**: drag anything. Small things (a laptop, a lamp, a box) can stand on a counter, desk,
  shelf or box, and move with it. Drag a thing into another room to move it there in Kept too.
- Drag a room's **amber corner** to resize it. Rooms on a floor can't overlap.
- **Draw a room** on empty ground. It becomes a new place on that floor straight away.
- **Add a floor** adds a place of the kind Floor, with one room in it.
- Select a room to set its **kind** (room, balcony, terrace, garden) and its **floor** (wood, tiles,
  concrete, deck, grass), or to **put a thing of that room on the map**.
- Select a thing to **turn** it, change its **shape**, or **take it off the map** (only what you put
  there yourself).

**Done** saves the whole arrangement at once, and the toast offers **Undo** for ten minutes.
**Cancel** puts the map back. If someone else arranged the same location while you were, Kept
says so and shows theirs, rather than overwriting it.

![Arranging: Move, Draw a room, Add a floor and Cancel above the map, each room's amber corner for resizing, and Done in the top bar](../../../assets/screens/map-arrange-light.webp)

The arrangement travels in a Kept export, so moving to another server keeps the map. A Homebox
import starts from the automatic layout.

## Detailed models

Furniture, plants and outdoor AC units are drawn with free models from
[Poly Haven](https://polyhaven.com) (CC0), shrunk for phones: about 150 KB each at most, about
1.5 MB for all of them, and only the floor in view loads its own. Everything else is drawn by Kept
itself. Turn off **Detailed models** under the map and nothing is downloaded at all; Kept
remembers that on this device.

If the browser can't draw 3D (an old phone, or graphics turned off), the map says so and the list
under it still has everything.
