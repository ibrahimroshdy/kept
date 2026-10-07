"""Fill a fresh, throwaway Homebox with the step-7 fixture data and download both exports.

Usage (the instance must be empty; see ../../2026-09-30-step7-homebox.md for the docker run):
    HB_BASE=http://127.0.0.1:3197/api/v1 python3 make_homebox_fixture.py <out-dir>
    docker restart <container>; python3 make_homebox_fixture.py <out-dir> export home homebox-0.26.2-home
    docker restart <container>; python3 make_homebox_fixture.py <out-dir> export family homebox-0.26.2-family

Synthetic data only, the Kept sample cast. Passwords are random per run and never written down;
the instance is deleted afterwards.
"""

import io
import json
import os
import secrets
import sys
import time
import zipfile

from hb_client import Client, HBError, login

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../../.."))
FIX = os.path.join(ROOT, "apps/server/test/fixtures")
OUT = sys.argv[1]
WORK = os.path.join(OUT, "_files")
os.makedirs(WORK, exist_ok=True)

PHOTO_A = os.path.join(FIX, "eval/thing-mug.jpg")
PHOTO_B = os.path.join(FIX, "eval/thing-drill-box.jpg")
RECEIPT = os.path.join(FIX, "eval/receipt-en.jpg")
PDF = os.path.join(FIX, "files/doc.pdf")


def copy(src, name):
    dst = os.path.join(WORK, name)
    with open(src, "rb") as a, open(dst, "wb") as b:
        b.write(a.read())
    return dst


def make_docx(name):
    """A tiny OOXML-shaped zip: a file type outside Kept's upload allow-list (plan Q15)."""
    dst = os.path.join(WORK, name)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("[Content_Types].xml", '<?xml version="1.0"?><Types/>')
        z.writestr("word/document.xml", "<w:document>Fixture manual</w:document>")
    with open(dst, "wb") as f:
        f.write(buf.getvalue())
    return dst


def make_text(name, text):
    dst = os.path.join(WORK, name)
    with open(dst, "w", encoding="utf-8") as f:
        f.write(text)
    return dst


def register(email, name, token=None):
    pw = secrets.token_urlsafe(18)
    body = {"email": email, "name": name, "password": pw}
    if token:
        body["token"] = token
    Client().post("/users/register", body)
    return pw


def as_user(email, pw, tenant=None):
    return Client(login(email, pw), tenant)


def update(c, eid, **kw):
    """PUT replaces the whole entity, so start from its current state."""
    cur = c.get(f"/entities/{eid}")
    body = {
        "id": eid,
        "name": cur["name"],
        "description": cur.get("description", ""),
        "notes": cur.get("notes", ""),
        "quantity": cur.get("quantity", 1),
        "insured": cur.get("insured", False),
        "archived": cur.get("archived", False),
        "assetId": cur.get("assetId", ""),
        "serialNumber": cur.get("serialNumber", ""),
        "modelNumber": cur.get("modelNumber", ""),
        "manufacturer": cur.get("manufacturer", ""),
        "lifetimeWarranty": cur.get("lifetimeWarranty", False),
        "warrantyExpires": cur.get("warrantyExpires", ""),
        "warrantyDetails": cur.get("warrantyDetails", ""),
        "purchaseDate": cur.get("purchaseDate", ""),
        "purchaseFrom": cur.get("purchaseFrom", ""),
        "purchasePrice": cur.get("purchasePrice", 0),
        "soldDate": cur.get("soldDate", ""),
        "soldTo": cur.get("soldTo", ""),
        "soldPrice": cur.get("soldPrice", 0),
        "soldNotes": cur.get("soldNotes", ""),
        "syncChildEntityLocations": cur.get("syncChildEntityLocations", False),
        "parentId": (cur.get("parent") or {}).get("id"),
        "entityTypeId": (cur.get("entityType") or {}).get("id"),
        "tagIds": [t["id"] for t in cur.get("tags") or []],
        "fields": cur.get("fields") or [],
    }
    body.update(kw)
    return c.put(f"/entities/{eid}", body)


def entity(c, name, type_id, parent=None, **kw):
    body = {"name": name, "entityTypeId": type_id}
    if parent:
        body["parentId"] = parent
    for k in ("description", "quantity", "tagIds"):
        if k in kw:
            body[k] = kw.pop(k)
    out = c.post("/entities", body)
    if kw:
        out = update(c, out["id"], **kw)
    return out


def attach(c, eid, path, kind, primary=False, name=None):
    if os.environ.get("HB_SKIP_FILES"):
        return None  # v0.27.0-rc.1's default file storage refuses uploads ("escapes bucket root")
    fields = {"type": kind, "primary": "true" if primary else "false"}
    fields["name"] = name or os.path.basename(path)
    return c.upload(f"/entities/{eid}/attachments", path, fields)


def export_collection(c, label):
    job = c.post("/group/exports")
    for _ in range(60):
        cur = c.get(f"/group/exports/{job['id']}")
        if cur["status"] in ("completed", "failed"):
            break
        time.sleep(1)
    if cur["status"] != "completed":
        raise HBError(f"export {label}: {cur}")
    status, headers, blob = c.get(f"/group/exports/{job['id']}/download", raw=True)
    path = os.path.join(OUT, f"{label}.zip")
    with open(path, "wb") as f:
        f.write(blob)
    return cur, headers, path


def main():
    log = {}

    # People. Ibrahim owns Home; Alfred owns بيت العائلة; Bruce and Louis join Home by invitation;
    # Ibrahim joins بيت العائلة by invitation, so one key sees both collections (H3).
    ib_pw = register("ibrahim@kept.test", "Ibrahim")
    al_pw = register("alfred@kept.test", "ألفريد")
    ib = as_user("ibrahim@kept.test", ib_pw)
    al = as_user("alfred@kept.test", al_pw)

    home = ib.get("/groups")
    fam = al.get("/groups")
    ib.put("/groups", {"name": "Home", "currency": "SAR"})
    al.put("/groups", {"name": "بيت العائلة", "currency": fam["currency"]})

    inv = ib.post("/groups/invitations", {"uses": 2, "expiresAt": "2027-01-01T00:00:00Z"})
    register("bruce@kept.test", "Bruce", inv["token"])
    register("louis@kept.test", "Louis", inv["token"])
    inv2 = al.post("/groups/invitations", {"uses": 1, "expiresAt": "2027-01-01T00:00:00Z"})
    ib.post(f"/groups/invitations/{inv2['token']}")

    h = Client(ib.token, home["id"])
    f = Client(ib.token, fam["id"])
    log["groups"] = {"home": home["id"], "family": fam["id"]}

    # ---------------------------------------------------------------- Home (SAR)
    loc_type = next(t for t in h.get("/entity-types") if t["isLocation"])
    room = h.post("/entity-types", {"name": "Room", "isLocation": True, "icon": "sofa-outline"})
    drawer_t = h.post("/entity-types", {"name": "Drawer", "isLocation": True, "icon": "dresser-outline"})
    appliance = h.post("/entity-types", {"name": "Appliance", "isLocation": False, "icon": "power-plug-outline"})
    tool = h.post("/entity-types", {"name": "Tool", "isLocation": False, "icon": "wrench-outline"})
    gadget = h.post("/entity-types", {"name": "Gadget", "isLocation": False, "icon": "laptop"})
    odd = h.post("/entity-types", {"name": "Odd icon", "isLocation": False, "icon": "not-a-homebox-icon"})

    t_elec = h.post("/tags", {"name": "Tech", "color": "#1e88e5", "icon": "laptop"})
    t_audio = h.post("/tags", {"name": "Audio", "color": "#8e24aa", "parentId": t_elec["id"]})
    t_kitchen = h.post("/tags", {"name": "مطبخ", "color": "#43a047", "description": "أدوات المطبخ"})
    t_fragile = h.post("/tags", {"name": "Fragile", "color": "red"})

    house = entity(h, "Home", loc_type["id"], description="The flat")
    kitchen = entity(h, "Kitchen", room["id"], house["id"])
    study = entity(h, "Study", room["id"], house["id"])
    shelf = entity(h, "Top shelf", loc_type["id"], study["id"])

    espresso = entity(
        h, "Espresso machine", appliance["id"], kitchen["id"],
        description="Dual boiler", tagIds=[t_kitchen["id"], t_fragile["id"]],
        notes="Descale monthly.\nUse filtered water.",
        manufacturer="Rocket", modelNumber="R58 Cinquantotto", serialNumber="SN-58-000417",
        purchaseDate="2024-11-03", purchaseFrom="Bean Bros", purchasePrice=12999.99,
        warrantyExpires="2026-11-03", warrantyDetails="Two years, parts and labour",
        insured=True,
        fields=[
            {"type": "text", "name": "Colour", "textValue": "Brushed steel"},
            {"type": "number", "name": "Boiler size (ml)", "numberValue": 1800},
            {"type": "boolean", "name": "Plumbed in", "booleanValue": True},
            {"type": "time", "name": "Last descaled"},
        ],
    )
    attach(h, espresso["id"], copy(PHOTO_A, "espresso-front.jpg"), "photo", primary=True)
    attach(h, espresso["id"], copy(PHOTO_B, "espresso-side.jpg"), "photo")
    attach(h, espresso["id"], copy(PDF, "espresso-manual.pdf"), "manual")
    attach(h, espresso["id"], copy(PDF, "espresso-warranty.pdf"), "warranty")
    attach(h, espresso["id"], copy(RECEIPT, "espresso-receipt.jpg"), "receipt")
    attach(h, espresso["id"], make_docx("espresso-quickstart.docx"), "attachment")
    attach(h, espresso["id"], make_text("espresso-notes.txt", "Grind 12 on the dial.\n"), "attachment")
    h.post(f"/entities/{espresso['id']}/attachments/external", {
        "source_type": "link", "external_id": "https://example.com/manuals/r58?lang=en#setup",
        "title": "Manufacturer page", "attachment_type": "manual",
    })
    h.post(f"/entities/{espresso['id']}/maintenance", {
        "name": "Descale", "description": "Citric acid", "completedDate": "2025-06-01", "cost": "350.50",
    })
    h.post(f"/entities/{espresso['id']}/maintenance", {
        "name": "Gasket change", "scheduledDate": "2026-12-01",
    })

    fridge = entity(h, "Fridge", appliance["id"], kitchen["id"], manufacturer="Bosch",
                    lifetimeWarranty=True, warrantyDetails="Compressor, lifetime",
                    purchasePrice=2499, purchaseDate="2023-02-14")
    attach(h, fridge["id"], copy(PHOTO_B, "fridge.jpg"), "photo", primary=True)

    toolbox = entity(h, "Toolbox", tool["id"], study["id"], description="Red metal box")
    drill = entity(h, "Cordless drill", tool["id"], toolbox["id"], manufacturer="Makita",
                   modelNumber="DHP485", tagIds=[t_audio["id"]])
    tray = entity(h, "Bits tray", drawer_t["id"], toolbox["id"])  # a location-type entity inside an item
    screws = entity(h, "Wood screws", tool["id"], tray["id"], quantity=2.5,
                    description="Boxes of 100; half a box left")

    phone = entity(h, "Old phone", gadget["id"], shelf["id"], manufacturer="Nokia", modelNumber="3310",
                   purchasePrice=199.5, purchaseDate="2019-05-01",
                   soldDate="2025-08-20", soldTo="Murdock", soldPrice=40, soldNotes="Paid in cash",
                   archived=True)
    lamp = entity(h, "Desk lamp", odd["id"], study["id"], tagIds=[t_elec["id"]])

    tmpl = h.post("/templates", {
        "name": "Kitchen appliance", "description": "Defaults for kitchen things",
        "defaultName": "New appliance", "defaultQuantity": 1, "defaultManufacturer": "Bosch",
        "defaultLocationId": kitchen["id"], "defaultTagIds": [t_kitchen["id"]],
        "includePurchaseFields": True, "includeWarrantyFields": True,
        "fields": [
            {"type": "text", "name": "Voltage", "textValue": "230 V"},
            {"type": "number", "name": "Watts", "numberValue": 1200},
            {"type": "boolean", "name": "Dishwasher safe", "booleanValue": False},
            {"type": "time", "name": "Installed", "timeValue": "2025-01-15T00:00:00Z"},
        ],
    })
    kettle = h.post(f"/templates/{tmpl['id']}/create-item", {
        "name": "Kettle", "parentId": kitchen["id"], "entityTypeId": appliance["id"], "quantity": 1,
    })

    try:
        h.post("/notifiers", {"name": "Fixture ntfy", "url": "ntfy://ntfy.example.com/kept-fixture", "isActive": False})
        log["notifier"] = "created"
    except HBError as e:
        log["notifier"] = str(e)

    # ---------------------------------------------------------------- بيت العائلة (USD, the default)
    f_loc = next(t for t in f.get("/entity-types") if t["isLocation"])
    f_item = f.post("/entity-types", {"name": "أجهزة", "isLocation": False, "icon": "lightbulb-outline"})
    f_tag = f.post("/tags", {"name": "غرفة المعيشة", "color": "#fb8c00"})
    living = entity(f, "غرفة المعيشة", f_loc["id"])
    cabinet = entity(f, "خزانة التلفزيون", f_loc["id"], living["id"])
    tv = entity(f, "تلفزيون سامسونج", f_item["id"], cabinet["id"], tagIds=[f_tag["id"]],
                manufacturer="Samsung", modelNumber="QA55Q60", serialNumber="٠١٢٣٤٥",
                purchaseDate="2022-07-10", purchaseFrom="كارفور", purchasePrice=18500,
                warrantyExpires="2025-07-10", notes="اشتريناه لألفريد")
    attach(f, tv["id"], copy(PHOTO_A, "تلفزيون.jpg"), "photo", primary=True)
    ac = entity(f, "مكيف هواء", f_item["id"], living["id"], quantity=1)
    f.post(f"/entities/{ac['id']}/maintenance", {"name": "تنظيف الفلتر", "completedDate": "2025-05-20", "cost": "1200"})
    remote = entity(f, "ريموت", f_item["id"], tv["id"], quantity=2)

    log["ids"] = {k: v["id"] for k, v in {
        "house": house, "kitchen": kitchen, "study": study, "shelf": shelf, "espresso": espresso,
        "fridge": fridge, "toolbox": toolbox, "drill": drill, "tray": tray, "screws": screws,
        "phone": phone, "lamp": lamp, "kettle": kettle, "living": living, "cabinet": cabinet,
        "tv": tv, "ac": ac, "remote": remote,
    }.items()}

    # Give background thumbnailing a moment, then ask for any that are missing.
    time.sleep(3)
    for c in (h, f):
        try:
            c.post("/actions/create-missing-thumbnails")
        except HBError as e:
            log.setdefault("thumbs", []).append(str(e))
        try:
            c.post("/actions/ensure-asset-ids")
        except HBError as e:
            log.setdefault("assetids", []).append(str(e))
    time.sleep(3)

    log["assets"] = {
        "home": {e["name"]: e.get("assetId") for e in h.get("/entities?includeArchived=true")["items"]},
        "family": {e["name"]: e.get("assetId") for e in f.get("/entities?includeArchived=true")["items"]},
    }

    with open(os.path.join(OUT, "run-log.json"), "w", encoding="utf-8") as fh:
        json.dump(log, fh, ensure_ascii=False, indent=2)
    # Session token and group ids for the export step; scratch only, never committed.
    with open(os.path.join(OUT, "_state.json"), "w") as fh:
        json.dump({"token": ib.token, "home": home["id"], "family": fam["id"]}, fh)
    print(json.dumps(log, ensure_ascii=False, indent=2))


def export_one(which, label):
    """Homebox v0.26.2 can publish one export job per process: its mem:// pubsub topic is shut down
    after the first send (fixed in v0.27.0-rc.1, #1592). Restart the container before each call."""
    st = json.load(open(os.path.join(OUT, "_state.json")))
    c = Client(st["token"], st[which])
    row, headers, path = export_collection(c, label)
    print(json.dumps({"export": row, "headers": {k: headers[k] for k in headers if k.lower().startswith("content")}}, indent=2))


if __name__ == "__main__":
    if len(sys.argv) > 2 and sys.argv[2] == "export":
        export_one(sys.argv[3], sys.argv[4])
    else:
        main()
