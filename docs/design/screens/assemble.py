#!/usr/bin/env python3
"""Builds docs/design/kept-screens.html from the fragments in this folder.

    python3 docs/design/screens/assemble.py

Page order: the flow map, then every area's frames in journey order, then the kit (twice, light
and dark). Each frame is a top-level <figure id="f-..."> in a fragment; this script numbers them
in page order, adds "From: … · Next: …" under each caption from FRAMES below, builds the sidebar
from the same numbers, and draws the flow diagrams as inline SVG whose boxes carry those numbers
and link to the frames. Nothing here reaches outside this folder.
"""
import html
import os
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE.parent / 'kept-screens.html'

# Page order, as the stages of the main journeys: set up, capture, scan and move, find, the rest.
AREAS = [
    ('01-home-onboarding.html', 'home-onboarding', 'Setup & Home'),
    ('03-capture-inbox.html', 'capture-inbox', 'Capture, inbox & scan'),
    ('02b-move-labels.html', 'move-labels', 'Move, check & labels'),
    ('04-search-assistant.html', 'search-assistant', 'Search & assistant'),
    ('02-browse-things.html', 'browse-things', 'Browse & things'),
    ('06-people-types.html', 'people-types', 'People, types & services'),
    ('05-vehicles-settings.html', 'vehicles-settings', 'Vehicles & settings'),
    ('07-import-ai.html', 'import-ai', 'Import & AI'),
    ('08-portability.html', 'portability', 'Import, export & consumables'),
    ('09-operations.html', 'operations', 'Backups, status & this device'),
]

# id: (sidebar title, from, next). A from/next entry is a frame id or plain words (an entry point).
FRAMES = {
    # Setup & Home
    'f-setup-code': ('Setup code', ["First visit to the server's address"], ['f-setup-account']),
    'f-setup-account': ('First account', ['f-setup-code'], ['f-setup-options']),
    'f-setup-options': ('Instance options', ['f-setup-account'], ['f-home-first']),
    'f-home-first': ('Home, the first time', ['f-setup-options', 'f-accept'], ['f-newloc-name']),
    'f-newloc-name': ('New location: name, kind', ['f-home-first', 'More → New location'], ['f-newloc-rooms']),
    'f-newloc-rooms': ('New location: rooms', ['f-newloc-name'], ['f-newloc-track']),
    'f-newloc-track': ('New location: what to track', ['f-newloc-rooms'], ['f-home-owner']),
    'f-home-owner': ('Home with Get started', ['f-newloc-track', 'Tab bar: Home'], ['f-install', 'f-capture', 'f-labels', 'f-ai-key', 'f-invite']),
    'f-install': ('Install on your phone', ['f-home-owner'], ['f-home-owner']),
    'f-home-dark': ('Home, checklist hidden', ['f-home-owner'], ['f-inbox', 'f-reading', 'f-notifs']),
    'f-home-ar': ('Home in Arabic', ['f-settings-me'], ['f-loc']),
    'f-home-desk': ('Home on a desktop', ['Sidebar: Home'], ['f-search-desk', 'f-loc-desk']),
    'f-setup-kit': ('Recovery kit', ['f-ai-key', 'f-admin'], ['f-admin']),
    # Capture, inbox & scan
    'f-capture': ('Capture: thing', ['Tab bar: Capture', 'f-home-owner'], ['f-capture-receipt', 'f-capture-label', 'f-capture-summary']),
    'f-capture-receipt': ('Capture: receipt', ['f-capture'], ['f-capture-summary']),
    'f-capture-label': ('A label in view', ['f-capture'], ['f-boxcheck', 'f-capture']),
    'f-capture-summary': ('Capture done, queued', ['f-capture'], ['f-sync']),
    'f-sync': ('Syncing, AI naming', ['f-capture-summary'], ['f-inbox']),
    'f-inbox': ('Inbox', ['f-sync', 'Tab bar: Inbox'], ['f-inbox-scroll', 'f-inbox-bulk', 'f-thing']),
    'f-inbox-scroll': ('Inbox, scrolled', ['f-inbox'], ['f-inbox-bulk']),
    'f-inbox-bulk': ('Accept names, Undo', ['f-inbox', 'f-inbox-scroll'], ['f-inbox']),
    'f-inbox-desk': ('Inbox on a desktop', ['Sidebar: Inbox'], ['f-inbox-multi']),
    'f-inbox-multi': ('One photo, six drafts', ['f-inbox-desk'], ['f-inbox-desk']),
    'f-inbox-everyone': ("Everyone's inbox", ['f-inbox'], ['f-thing']),
    'f-inbox-ar': ('Inbox in Arabic', ['f-inbox'], []),
    'f-scan': ('Scan', ['Header: Scan, on Home and Search', 'f-tray-pick'], ['f-thing', 'f-scan-legacy', 'f-scan-claim', 'f-scan-notyours', 'f-scan-barcode', 'f-scan-notkept', 'f-scan-notonphone']),
    'f-scan-legacy': ('Scan: old Homebox label', ['f-scan'], ['f-thing']),
    'f-scan-claim': ('Scan: blank label', ['f-scan'], ['f-boxcheck']),
    'f-scan-notyours': ('Scan: not in your Kept', ['f-scan'], ['f-scan']),
    'f-scan-barcode': ('Scan: product barcode', ['f-scan'], ['f-inbox']),
    'f-scan-notkept': ('Scan: not a Kept label', ['f-scan'], ['f-scan']),
    'f-scan-notonphone': ('Scan: not on this phone', ['f-scan'], ['f-scan']),
    # Move, check & labels
    'f-tray-pick': ('Tray: pick up', ['f-loc', 'f-thing-menu'], ['f-tray-scan']),
    'f-tray-scan': ('Tray: scan the destination', ['f-tray-pick'], ['f-tray-land']),
    'f-tray-land': ('Tray: landed, Undo', ['f-tray-scan'], ['f-loc']),
    'f-boxcheck': ('Box check', ['f-scan', 'f-capture-label', 'f-scan-claim'], ['f-thing']),
    'f-labels': ('Print labels', ['f-home-owner', 'f-thing-menu', 'Sidebar or More: Labels'], ['f-labels-ok']),
    'f-labels-ok': ('Printed OK?', ['f-labels'], ['f-labels', 'f-scan']),
    # Search & assistant
    'f-search': ('Search', ['Tab bar: Search'], ['f-thing', 'f-loc', 'f-scan']),
    'f-search-desk': ('⌘K palette', ['Top bar: Search or jump to…', 'f-home-desk'], ['f-thing-desk', 'f-asst-desk']),
    'f-search-offline': ('Search offline', ['f-search'], ['f-thing']),
    'f-search-ar': ('Search in Arabic', ['f-search'], ['f-thing-ar']),
    'f-asst': ('Assistant', ['Header: Assistant'], ['f-asst-card']),
    'f-asst-card': ('Assistant: confirm card', ['f-asst', 'f-asst-desk'], ['f-asst-states', 'f-activity']),
    'f-asst-states': ('Assistant: card states', ['f-asst-card'], ['f-asst']),
    'f-asst-desk': ('Assistant, docked', ['f-search-desk'], ['f-asst-card']),
    'f-notifs': ('Notifications', ['Header: the bell', 'f-home-dark'], ['f-thing', 'f-vehicle']),
    'f-activity': ('Activity', ['Sidebar or More: Activity', 'f-asst-card'], ['f-thing-desk']),
    'f-conflict': ('Conflict', ['f-thing'], ['f-thing']),
    # Browse & things
    'f-loc': ('Location, filter strip', ['f-search', 'More: Locations', 'f-home-ar'], ['f-views', 'f-thing', 'f-tray-pick']),
    'f-views': ('Saved views', ['f-loc'], ['f-loc']),
    'f-loc-desk': ('Location, Display menu', ['Sidebar: Locations', 'f-home-desk'], ['f-thing-desk', 'f-labels']),
    'f-thing': ('Thing page', ['f-loc', 'f-search', 'f-scan'], ['f-thing-scroll', 'f-thing-menu', 'f-secret']),
    'f-thing-scroll': ('Thing page, scrolled', ['f-thing'], ['f-activity']),
    'f-thing-menu': ('Thing action menu', ['f-thing'], ['f-labels', 'f-tray-pick']),
    'f-secret': ('Secret reveal', ['f-thing'], ['f-activity']),
    'f-thing-desk': ('Thing on a desktop', ['f-loc-desk', 'f-search-desk'], ['f-activity']),
    'f-thing-ar': ('Thing in Arabic', ['f-search-ar'], []),
    # People, types & services
    'f-members': ('Members', ['Settings → a location → Members'], ['f-invite']),
    'f-members-desk': ('Members on a desktop', ['Settings → a location → Members'], ['f-invite']),
    'f-invite': ('Invite', ['f-members', 'f-home-owner'], ['f-accept']),
    'f-accept': ('Accept invite', ['The invite link'], ['f-home-first']),
    'f-track': ('What to track', ['Settings → a location → What to track'], ['f-home-owner']),
    'f-personal': ('Personal location', ['More: Locations'], ['f-thing']),
    'f-types': ('Type editor', ['Settings → Account → Types'], []),
    'f-service': ('Log a service', ['f-vehicle'], ['f-vehicle-dark']),
    'f-viewer': ("A viewer's thing page", ['f-search'], []),
    # Vehicles & settings
    'f-vehicle': ('Vehicle', ['Sidebar or More: Vehicles', 'f-notifs'], ['f-reading', 'f-service', 'f-vehicle-desk']),
    'f-vehicle-dark': ('Vehicle, services', ['f-vehicle', 'f-service'], []),
    'f-vehicle-desk': ('Vehicle costs', ['f-vehicle'], []),
    'f-reading': ('Log a reading', ['f-vehicle', 'f-home-dark'], ['f-vehicle']),
    'f-vehicle-ar': ('Vehicle in Arabic', ['f-vehicle'], []),
    'f-settings-me': ('Settings: Me', ['Sidebar or More: Settings'], ['f-ai-key', 'f-import-file', 'f-connections']),
    'f-ai-settings': ('AI settings, Advanced', ['f-ai-key'], ['f-ai-usage']),
    'f-connections': ('Connections', ['f-settings-me'], []),
    'f-admin': ('Admin status', ['Settings → Admin'], ['f-setup-kit']),
    # Import & AI
    'f-import-file': ('Import: choose the file', ['Settings → Import', 'f-settings-me'], ['f-import-map']),
    'f-import-map': ('Import: match the columns', ['f-import-file'], ['f-import-choices']),
    'f-import-choices': ('Import: a few choices', ['f-import-map'], ['f-import-check']),
    'f-import-check': ('Import: check it', ['f-import-choices'], ['f-import-done', 'f-import-map']),
    'f-import-done': ('Import: done', ['f-import-check'], ['f-loc']),
    'f-ai-key': ('AI key: save and test', ['Settings → AI', 'f-home-owner'], ['f-ai-settings', 'f-ai-usage']),
    'f-ai-key-fail': ('AI key: test failed', ['f-ai-key'], ['f-ai-key']),
    'f-ai-usage': ('AI usage', ['f-ai-settings', 'f-ai-key'], ['f-ai-paused']),
    'f-ai-paused': ('AI paused', ['f-ai-usage'], ['f-ai-settings']),
    # Import, export & consumables (step 7, plan T3)
    'f-import-source': ('Import: where from', ['Settings → Import'], ['f-import-file', 'f-import-archive']),
    'f-import-archive': ('Import: the archive', ['f-import-source'], ['f-import-inspect']),
    'f-import-inspect': ("Import: what's in it", ['f-import-archive'], ['f-import-target']),
    'f-import-target': ('Import: where it goes', ['f-import-inspect'], ['f-import-hb-choices', 'f-import-kept-ar']),
    'f-import-hb-choices': ('Import: Homebox choices', ['f-import-target'], ['f-import-report']),
    'f-import-report': ('Import: the report', ['f-import-hb-choices'], ['f-import-enrich', 'f-invite']),
    'f-import-enrich': ('Import done, search words', ['f-import-report'], ['f-loc']),
    'f-import-kept-ar': ('A Kept export in Arabic', ['f-import-inspect'], ['f-import-report']),
    'f-export-sheet': ('Export a location', ['Settings → Export', 'f-export-list'], ['f-export-list']),
    'f-export-list': ('Your exports', ['Settings → Export', 'f-export-sheet'], ['f-export-sheet']),
    'f-export-first': ('Delete: export first', ['Settings → a location → General'], ['f-export-list']),
    'f-legacy-picker': ('An old Homebox label', ['f-scan', 'A printed Homebox label'], ['f-thing']),
    'f-consumables': ('Consumables', ['Sidebar or More: Consumables', 'Home: running low'], ['f-consumables-adjust']),
    'f-consumables-adjust': ('Adjust, keep at least', ['f-consumables', 'f-thing'], ['f-consumables']),
    'f-convert-field': ('Make a field secret', ['f-types'], ['f-types']),
    'f-templates': ('Templates', ['Settings → Account → Templates'], ['f-template-sheet']),
    'f-template-sheet': ('Template sheet', ['f-templates', 'f-thing-menu'], ['f-templates']),
    # Backups, status & this device (step 8, plan T3)
    'f-backups-s3': ('Backups: S3-compatible', ['Settings → Admin → Backups', 'f-status-ops'], ['f-backups-desk', 'f-kit-reauth']),
    'f-backups-sftp': ('Backups: SFTP', ['f-backups-s3'], ['f-backups-desk']),
    'f-backups-locked': ('Backups: set by the server', ['Settings → Admin → Backups'], ['f-status-ops']),
    'f-backups-desk': ('Backups: runs and snapshots', ['Settings → Admin → Backups', 'f-status-ops'], ['f-backups-s3']),
    'f-status-ops': ('Status, complete', ['Settings → Admin → Status'], ['f-backups-desk', 'f-kit-reauth']),
    'f-status-ar': ('Status in Arabic', ['Settings → Admin → Status'], ['f-backups-s3', 'f-kit-reauth']),
    'f-kit-reauth': ('Download the recovery kit', ['f-status-ops', 'f-backups-s3', 'f-setup-kit'], ['f-status-ops']),
    'f-device': ('This device', ['Settings → Me → This device'], ['f-lock-screen']),
    'f-lock-screen': ('Lock screen', ['Opening Kept', 'Five minutes away', 'f-device'], ['f-home-owner']),
}

# ----------------------------------------------------------------------------------------------
# Flow diagrams. Nodes: key -> (col, row, ref, label, kind). ref is a frame id, 'START', 'END',
# '#anchor' or None. kind: main | err | perm | later | sys | nav. Edges: (a, b, label, kind, route),
# route: auto | under | over | wrap. Labels use "\n" for a second line.
JOURNEYS = [
    dict(id='flow-first-run', title='First run: from a fresh server to a set-up home',
         caption='The instance admin enters the setup code from the logs, creates the first account and sets sign-up, then Home offers the first location. The new-location wizard is skippable after the name; the Get started checklist takes over from there.',
         gaps={}, rows=4,
         nodes=dict(
             s=(0, 0, 'START', "Open the server's\naddress", 'main'),
             code=(1, 0, 'f-setup-code', 'Enter the\nsetup code', 'main'),
             acct=(2, 0, 'f-setup-account', 'Create the\nfirst account', 'main'),
             opts=(3, 0, 'f-setup-options', 'How should this\nKept work?', 'main'),
             home1=(4, 0, 'f-home-first', 'Home: Create\nyour first home', 'main'),
             bad=(1, 1, 'f-setup-code', "Wrong code:\ncheck the logs", 'err'),
             done=(2, 1, None, 'Already set up:\nSign in instead', 'perm'),
             name=(0, 2, 'f-newloc-name', 'Name and kind', 'main'),
             rooms=(1, 2, 'f-newloc-rooms', 'Rooms from\nthe template', 'main'),
             track=(2, 2, 'f-newloc-track', 'What to track', 'main'),
             owner=(3, 2, 'f-home-owner', 'Home with\nGet started', 'main'),
             e=(4, 2, 'END', 'Set up', 'main'),
             install=(3, 3, 'f-install', 'Install on\nthis phone', 'main'),
         ),
         edges=[('s', 'code', '', 'main', 'auto'), ('code', 'acct', 'Continue', 'main', 'auto'),
                ('acct', 'opts', 'Create\naccount', 'main', 'auto'), ('opts', 'home1', 'Finish\nsetup', 'main', 'auto'),
                ('code', 'bad', 'rejected', 'err', 'auto'), ('acct', 'done', 'set up\nearlier', 'perm', 'auto'),
                ('home1', 'name', 'Create', 'main', 'wrap'), ('name', 'rooms', 'Next', 'main', 'auto'),
                ('rooms', 'track', 'Next\nor Skip', 'main', 'auto'), ('track', 'owner', 'Create\nHome', 'main', 'auto'),
                ('owner', 'e', 'steps\ndone', 'main', 'auto'), ('owner', 'install', 'How', 'main', 'auto')]),
    dict(id='flow-capture', title='Capture: photo to inventory, even offline',
         caption='Every photo is saved on the phone first and queued. When the phone is back online the queue syncs, AI names what it can, and anything with money, dates or no name waits in the Inbox as Suggested. Accepting several names at once gives an Undo for 10 seconds.',
         gaps={}, rows=2,
         nodes=dict(
             s=(0, 0, 'START', 'Tap Capture', 'main'),
             cap=(1, 0, 'f-capture', 'Camera open,\nplace chip', 'main'),
             sum=(2, 0, 'f-capture-summary', 'Capture done:\nqueued here', 'main'),
             sync=(3, 0, 'f-sync', 'Back online:\nsync, AI names', 'main'),
             inbox=(4, 0, 'f-inbox', 'Inbox:\nSuggested values', 'main'),
             bulk=(5, 0, 'f-inbox-bulk', 'Accept names,\nUndo 10 s', 'main'),
             e=(5, 1, 'END', 'In the\ninventory', 'main'),
             viewer=(0, 1, None, 'Viewers: no\nCapture, no Inbox', 'perm'),
             receipt=(1, 1, 'f-capture-receipt', 'Receipt mode', 'main'),
             label=(2, 1, 'f-capture-label', 'A Kept label\nin view', 'main'),
             paused=(3, 1, 'f-ai-paused', 'AI paused:\nnaming waits', 'err'),
             desk=(4, 1, 'f-inbox-desk', 'Review at\nthe desk', 'main'),
         ),
         edges=[('s', 'cap', '', 'main', 'auto'), ('cap', 'sum', 'Done', 'main', 'auto'),
                ('sum', 'sync', 'connection\nback', 'main', 'auto'), ('sync', 'inbox', 'needs you', 'main', 'auto'),
                ('inbox', 'bulk', 'select,\nAccept', 'main', 'auto'), ('bulk', 'e', '', 'main', 'auto'),
                ('s', 'viewer', 'viewer', 'perm', 'auto'), ('cap', 'receipt', 'mode', 'main', 'auto'),
                ('cap', 'label', 'label\nseen', 'main', 'auto'), ('sync', 'paused', 'cap\nreached', 'err', 'auto'),
                ('inbox', 'desk', 'at a\ndesk', 'main', 'auto')]),
    dict(id='flow-scan', title='Scan: six answers, then carry or check',
         caption='A scan resolves on the phone first, then on the server. It always gives one of six answers, and never says whether a label belongs to someone else. From a thing you can pick it up in the carrying tray; from a box, check its contents.',
         gaps={1: 110}, rows=7,
         nodes=dict(
             s=(0, 3, 'START', 'Tap Scan\n(Home, Search)', 'main'),
             scan=(1, 3, 'f-scan', 'Point at a label\nor a barcode', 'main'),
             cam=(1, 5, 'f-scan', "Camera can't:\nType the code", 'err'),
             open=(2, 0, 'f-thing', 'Thing opens,\nlast seen now', 'main'),
             legacy=(2, 1, 'f-scan-legacy', 'Old Homebox\nlabel', 'main'),
             claim=(2, 2, 'f-scan-claim', 'Blank label:\nclaim it', 'main'),
             notyours=(2, 3, 'f-scan-notyours', 'Not in\nyour Kept', 'perm'),
             barcode=(2, 4, 'f-scan-barcode', 'Product barcode:\nadd as new', 'main'),
             notkept=(2, 5, 'f-scan-notkept', 'Not a\nKept label', 'err'),
             offline=(2, 6, 'f-scan-notonphone', 'Not on\nthis phone', 'err'),
             pick=(3, 0, 'f-tray-pick', 'Pick up:\nCarrying 3', 'main'),
             dest=(4, 0, 'f-tray-scan', 'Scan the\ndestination', 'main'),
             land=(5, 0, 'f-tray-land', 'Moved,\nUndo 10 s', 'main'),
             e=(5, 1, 'END', 'Moved', 'main'),
             box=(3, 2, 'f-boxcheck', 'Box check:\nfound 2 of 3', 'main'),
             e2=(5, 2, 'END', 'Checked', 'main'),
         ),
         edges=[('s', 'scan', '', 'main', 'auto'), ('scan', 'cam', 'no camera', 'err', 'auto'),
                ('scan', 'open', 'yours', 'main', 'auto'), ('scan', 'legacy', 'Homebox ID', 'main', 'auto'),
                ('scan', 'claim', 'blank', 'main', 'auto'), ('scan', 'notyours', "can't see it", 'perm', 'auto'),
                ('scan', 'barcode', 'barcode', 'main', 'auto'), ('scan', 'notkept', 'other QR', 'err', 'auto'),
                ('scan', 'offline', 'offline,\nunknown', 'err', 'auto'),
                ('open', 'pick', 'Pick up', 'main', 'auto'), ('pick', 'dest', 'Scan', 'main', 'auto'),
                ('dest', 'land', 'Move 3\nhere', 'main', 'auto'), ('land', 'e', '', 'main', 'auto'),
                ('claim', 'box', 'New box\nhere', 'main', 'auto'), ('open', 'box', 'box', 'main', 'elbowv'),
                ('box', 'e2', 'unticked:\nnot here', 'main', 'auto')]),
    dict(id='flow-labels', title='Labels: print, then confirm',
         caption="Printing never assumes the printer got it right. The builder leaves out things whose ID is still pending, starts on the first free cell of a partly used sheet, and opens the browser's print dialog; Kept then asks \"Printed OK?\" and only a yes records the print date.",
         gaps={}, rows=2,
         nodes=dict(
             s=(0, 0, 'START', 'Labels, a thing,\nor Get started', 'main'),
             build=(1, 0, 'f-labels', 'Stock and\nstart cell', 'main'),
             dlg=(2, 0, None, "Browser's print\ndialog, 100%", 'sys'),
             ok=(3, 0, 'f-labels-ok', 'Printed OK?', 'main'),
             e=(4, 0, 'END', 'Print date\nrecorded', 'main'),
             perm=(0, 1, None, 'Viewer, or labels\noff: no printing', 'perm'),
             pend=(1, 1, 'f-labels', 'ID pending:\nleft out', 'err'),
         ),
         edges=[('s', 'build', '', 'main', 'auto'), ('build', 'dlg', 'Print\n12 labels', 'main', 'auto'),
                ('dlg', 'ok', 'printed', 'main', 'auto'), ('ok', 'e', 'Yes,\nprinted OK', 'main', 'auto'),
                ('ok', 'build', 'No, print again', 'err', 'over'), ('s', 'perm', 'viewer', 'perm', 'auto'),
                ('build', 'pend', 'not synced', 'err', 'auto')]),
    dict(id='flow-find', title='Find: search, narrow, open',
         caption='Search answers from Postgres and never waits on a model; results open the thing directly. Inside a location, the filter strip narrows the list, a saved view keeps the filters, and the Display button holds sort and grouping. Offline, results come from the phone.',
         gaps={}, rows=2,
         nodes=dict(
             s=(0, 0, 'START', 'Search tab\nor ⌘K', 'main'),
             search=(1, 0, 'f-search', 'Things, then\ndocuments', 'main'),
             loc=(2, 0, 'f-loc', 'Location:\nfilter strip', 'main'),
             views=(3, 0, 'f-views', 'Save as\na view', 'main'),
             disp=(4, 0, 'f-loc-desk', 'Display:\nsort, group', 'main'),
             thing=(5, 0, 'f-thing', 'Thing page', 'main'),
             e=(5, 1, 'END', 'Found', 'main'),
             desk=(0, 1, 'f-search-desk', '⌘K palette\non a desktop', 'main'),
             off=(1, 1, 'f-search-offline', 'Offline: from\nthis phone', 'err'),
             none=(2, 1, '#kit', 'No results:\nempty state', 'err'),
             viewer=(3, 1, 'f-viewer', 'Viewer:\nread only', 'perm'),
         ),
         edges=[('s', 'search', '', 'main', 'auto'), ('search', 'loc', 'a place', 'main', 'auto'),
                ('loc', 'views', 'filter,\nSave view', 'main', 'auto'), ('views', 'disp', 'Display', 'main', 'auto'),
                ('disp', 'thing', 'open', 'main', 'auto'), ('thing', 'e', '', 'main', 'auto'),
                ('search', 'thing', 'open a result', 'main', 'over'), ('s', 'desk', 'desktop', 'main', 'auto'),
                ('search', 'off', 'offline', 'err', 'auto'), ('search', 'none', 'nothing\nmatches', 'err', 'auto'),
                ('loc', 'viewer', 'viewer', 'perm', 'auto')]),
    dict(id='flow-import', title='Import: a CSV, checked before anything lands',
         caption='Owners and admins import into a location. The file is read on the device first; the check runs every row the way the import will and changes nothing. Homebox import is shown but not built: it says "Coming in a later version".',
         gaps={}, rows=4,
         nodes=dict(
             s=(0, 0, 'START', 'Settings\n→ Import', 'main'),
             file=(1, 0, 'f-import-file', 'Choose the file\n(CSV)', 'main'),
             map=(2, 0, 'f-import-map', 'Match the\ncolumns', 'main'),
             ch=(3, 0, 'f-import-choices', 'A few choices', 'main'),
             chk=(4, 0, 'f-import-check', 'What the import\nwill do', 'main'),
             done=(4, 2, 'f-import-done', 'Importing,\nthen Done', 'main'),
             e=(5, 2, 'END', 'Open the\nlocation', 'main'),
             perm=(0, 1, None, 'Members, viewers:\nowners, admins only', 'perm'),
             hb=(1, 1, 'f-import-file', 'Homebox: in a\nlater version', 'later'),
             bad=(2, 1, 'f-import-file', "This file can't\nbe imported", 'err'),
             stop=(4, 3, 'f-import-done', 'Stopped: Resume\nfrom row n', 'err'),
         ),
         edges=[('s', 'file', '', 'main', 'auto'), ('file', 'map', 'Next', 'main', 'auto'), ('map', 'ch', 'Next', 'main', 'auto'),
                ('ch', 'chk', 'Check the\nimport', 'main', 'auto'), ('chk', 'done', 'Import\n214 things', 'main', 'auto'),
                ('done', 'e', 'Open', 'main', 'auto'), ('chk', 'map', 'Adjust mapping', 'main', 'over'),
                ('s', 'perm', 'member', 'perm', 'auto'), ('file', 'hb', 'Homebox', 'perm', 'auto'),
                ('file', 'bad', 'unreadable', 'err', 'auto'), ('done', 'stop', 'stopped', 'err', 'auto')]),
    dict(id='flow-ai', title='AI settings: a key, a test, a cap, the usage',
         caption='Pasting a key saves it and runs the test at once: a photo and a structured answer. After the first key Kept offers a monthly limit; at 80% it warns, at the limit AI pauses until the 1st while captures still save. Usage shows what every call cost.',
         gaps={}, rows=2,
         nodes=dict(
             s=(0, 0, 'START', 'Settings → AI,\nor Get started', 'main'),
             key=(1, 0, 'f-ai-key', 'Paste the key:\nSave and test', 'main'),
             cap=(2, 0, 'f-ai-settings', 'Monthly limit,\nAdvanced', 'main'),
             use=(3, 0, 'f-ai-usage', 'AI usage', 'main'),
             e=(4, 0, 'END', 'AI on,\ncapped', 'main'),
             perm=(0, 1, None, 'Members: personal\nkey, own usage', 'perm'),
             fail=(1, 1, 'f-ai-key-fail', 'Test failed:\nphotos not read', 'err'),
             kit=(2, 1, 'f-setup-kit', 'Recovery kit\nfirst', 'err'),
             paused=(3, 1, 'f-ai-paused', 'Cap reached:\nAI paused', 'err'),
         ),
         edges=[('s', 'key', '', 'main', 'auto'), ('key', 'cap', 'Set USD 5\na month', 'main', 'auto'),
                ('cap', 'use', 'AI usage', 'main', 'auto'), ('use', 'e', '', 'main', 'auto'),
                ('s', 'perm', 'member', 'perm', 'auto'), ('key', 'fail', 'test fails', 'err', 'auto'),
                ('key', 'kit', 'no kit yet', 'err', 'auto'), ('use', 'paused', '100%', 'err', 'auto')]),
]

NAVMAP = dict(
    id='flow-nav', title='Navigation map: the tab bar and sidebar, and what only opens from inside',
    caption='The first column is where a person starts: the phone tab bar, the desktop sidebar (the same entries sit under More on a phone), a header button, or a link from outside. The second column is what those reach directly. Everything to the right opens only from inside another screen.',
    gaps={0: 60, 1: 60, 2: 60}, rows=21, rgap=16, bh=46,
    heads=['Entry point', 'Reached directly', 'Only from inside', 'Deeper still'],
    nodes=dict(
        n0=(0, 0, None, 'Home\ntab · sidebar', 'nav'), a0=(1, 0, 'f-home-owner', 'Home', 'main'),
        b0=(2, 0, 'f-install', 'Install on\nthis phone', 'main'), b0b=(2, 1, 'f-reading', 'Log a reading', 'main'),
        n1=(0, 2, None, 'Search\ntab · ⌘K', 'nav'), a1=(1, 2, 'f-search', 'Search', 'main'), b1=(2, 2, 'f-thing', 'Thing page', 'main'),
        c1=(3, 2, 'f-thing-menu', 'Action menu', 'main'), c1b=(3, 3, 'f-secret', 'Secret reveal', 'main'),
        n2=(0, 4, None, 'Capture\ntab · top bar', 'nav'), a2=(1, 4, 'f-capture', 'Capture', 'main'), b2=(2, 4, 'f-capture-summary', 'Capture done', 'main'),
        n3=(0, 5, None, 'Inbox\ntab · sidebar', 'nav'), a3=(1, 5, 'f-inbox', 'Inbox', 'main'), b3=(2, 5, 'f-inbox-bulk', 'Accept names', 'main'),
        n4=(0, 6, None, 'Scan\nHome, Search header', 'nav'), a4=(1, 6, 'f-scan', 'Scan', 'main'), b4=(2, 6, 'f-scan-claim', 'Six answers', 'main'), c4=(3, 6, 'f-tray-pick', 'Carrying tray', 'main'),
        n5=(0, 7, None, 'Locations\nsidebar · More', 'nav'), a5=(1, 7, 'f-loc', 'Location', 'main'), b5=(2, 7, 'f-views', 'Saved views', 'main'), b5b=(2, 8, 'f-boxcheck', 'Box check', 'main'),
        n6=(0, 9, None, 'Vehicles\nsidebar · More', 'nav'), a6=(1, 9, 'f-vehicle', 'Vehicle', 'main'), b6=(2, 9, 'f-service', 'Log a service', 'main'),
        n7=(0, 10, None, 'Labels\nsidebar · More', 'nav'), a7=(1, 10, 'f-labels', 'Print labels', 'main'), b7=(2, 10, 'f-labels-ok', 'Printed OK?', 'main'),
        n8=(0, 11, None, 'Activity\nsidebar · More', 'nav'), a8=(1, 11, 'f-activity', 'Activity', 'main'),
        n9=(0, 12, None, 'Notifications\nbell · sidebar', 'nav'), a9=(1, 12, 'f-notifs', 'Notifications', 'main'),
        na=(0, 13, None, 'Assistant\nheader button', 'nav'), aa=(1, 13, 'f-asst', 'Assistant', 'main'), ba=(2, 13, 'f-asst-card', 'Confirm card', 'main'),
        nb=(0, 14, None, 'Settings\nsidebar · More', 'nav'), ab=(1, 14, 'f-settings-me', 'Settings: Me', 'main'),
        bb1=(2, 14, 'f-ai-key', 'AI', 'main'), cb1=(3, 14, 'f-ai-usage', 'AI usage', 'main'),
        bb2=(2, 15, 'f-import-file', 'Import', 'main'),
        bb3=(2, 16, 'f-members', 'Members', 'main'), cb3=(3, 16, 'f-invite', 'Invite', 'main'),
        bb4=(2, 17, 'f-types', 'Type editor', 'main'),
        bb5=(2, 18, 'f-admin', 'Instance admin', 'main'), cb5=(3, 18, 'f-setup-kit', 'Recovery kit', 'main'),
        nc=(0, 19, None, 'A link from\noutside Kept', 'nav'), ac=(1, 19, 'f-accept', 'Accept invite', 'main'), ac2=(1, 20, 'f-setup-code', 'First run\n(a new server)', 'main'),
    ),
    edges=[('n0', 'a0', '', 'main', 'auto'), ('a0', 'b0', '', 'main', 'auto'), ('a0', 'b0b', '', 'main', 'auto'),
           ('n1', 'a1', '', 'main', 'auto'), ('a1', 'b1', '', 'main', 'auto'), ('b1', 'c1', '', 'main', 'auto'), ('b1', 'c1b', '', 'main', 'auto'),
           ('n2', 'a2', '', 'main', 'auto'), ('a2', 'b2', '', 'main', 'auto'),
           ('n3', 'a3', '', 'main', 'auto'), ('a3', 'b3', '', 'main', 'auto'),
           ('n4', 'a4', '', 'main', 'auto'), ('a4', 'b4', '', 'main', 'auto'), ('b4', 'c4', '', 'main', 'auto'),
           ('n5', 'a5', '', 'main', 'auto'), ('a5', 'b5', '', 'main', 'auto'), ('a5', 'b5b', '', 'main', 'auto'),
           ('n6', 'a6', '', 'main', 'auto'), ('a6', 'b6', '', 'main', 'auto'),
           ('n7', 'a7', '', 'main', 'auto'), ('a7', 'b7', '', 'main', 'auto'),
           ('n8', 'a8', '', 'main', 'auto'), ('n9', 'a9', '', 'main', 'auto'),
           ('na', 'aa', '', 'main', 'auto'), ('aa', 'ba', '', 'main', 'auto'),
           ('nb', 'ab', '', 'main', 'auto'), ('ab', 'bb1', '', 'main', 'auto'), ('bb1', 'cb1', '', 'main', 'auto'),
           ('ab', 'bb2', '', 'main', 'auto'), ('ab', 'bb3', '', 'main', 'auto'), ('bb3', 'cb3', '', 'main', 'auto'),
           ('ab', 'bb4', '', 'main', 'auto'), ('ab', 'bb5', '', 'main', 'auto'), ('bb5', 'cb5', '', 'main', 'auto'),
           ('nc', 'ac', 'invite', 'main', 'auto'), ('nc', 'ac2', 'setup', 'main', 'auto')],
)

BW, BH = 120, 54          # box
GAP, RGAP = 60, 44        # default gap between columns, between rows
M = 20                    # margin
esc = html.escape


def draw(j, numbers):
    """One diagram as inline SVG. Returns the <figure> markup."""
    nodes, edges = j['nodes'], j['edges']
    rgap = j.get('rgap', RGAP)
    bh = j.get('bh', BH)
    ncols = max(n[0] for n in nodes.values()) + 1
    gaps = [j['gaps'].get(c, GAP) for c in range(ncols)]
    xs, x = [], M
    for c in range(ncols):
        xs.append(x)
        x += BW + gaps[c]
    width = x - gaps[-1] + M
    top = M + (26 if j.get('heads') else 0) + (22 if any(e[4] == 'over' for e in edges) else 0)
    rows = j['rows']
    height = top + rows * bh + (rows - 1) * rgap + M + 4
    box = {}
    for k, (c, r, ref, label, kind) in nodes.items():
        bx, by = xs[c], top + r * (bh + rgap)
        box[k] = (bx, by, BW, bh)
    out = [f'<svg viewBox="0 0 {width} {height}" width="{width}" height="{height}" role="img" '
           f'style="width:100%;max-width:{width}px;min-width:{int(width * .86)}px" '
           f'aria-label="{esc(j["title"])}" xmlns="http://www.w3.org/2000/svg">']
    if j.get('heads'):
        for c, h in enumerate(j['heads']):
            out.append(f'<text class="fl-hd" x="{xs[c]}" y="{M + 8}">{esc(h)}</text>')
    labels = []

    def arrow(x2, y2, dx, dy, kind):
        # a small filled triangle pointing along (dx, dy)
        L, W = 8, 4.5
        bx_, by_ = x2 - dx * L, y2 - dy * L
        px, py = -dy * W, dx * W
        return (f'<polygon class="fl-ah {kind}" points="{x2:.1f},{y2:.1f} {bx_ + px:.1f},{by_ + py:.1f} '
                f'{bx_ - px:.1f},{by_ - py:.1f}"/>')

    for a, b, label, kind, route in edges:
        ax, ay, aw, ah = box[a]
        bx, by, bw, bh_ = box[b]
        ca, cb = nodes[a][0], nodes[b][0]
        ra, rb = nodes[a][1], nodes[b][1]
        k = '' if kind == 'main' else kind
        if route == 'over':
            y = min(ay, by) - 16
            x1, x2 = ax + aw / 2, bx + bw / 2
            pts = [(x1, ay), (x1, y), (x2, y), (x2, by)]
            lab = ((x1 + x2) / 2, y, 'h')
        elif route == 'wrap':
            y = by - rgap / 2
            x1, x2 = ax + aw / 2, bx + bw / 2
            pts = [(x1, ay + ah), (x1, y), (x2, y), (x2, by)]
            lab = ((x1 + x2) / 2, y, 'h')
        elif ca == cb:
            x1 = ax + aw / 2
            if rb > ra:
                pts = [(x1, ay + ah), (x1, by)]
            else:
                pts = [(x1, ay), (x1, by + bh_)]
            lab = (x1 + 6, (pts[0][1] + pts[1][1]) / 2, 'v')
        elif ra == rb:
            if cb > ca:
                pts = [(ax + aw, ay + ah / 2), (bx, by + bh_ / 2)]
            else:
                pts = [(ax, ay + ah / 2), (bx + bw, by + bh_ / 2)]
            lab = ((pts[0][0] + pts[1][0]) / 2, pts[0][1], 'h')
        else:  # elbow: out of A's side, turn just after it, into B's side
            xm = ax + aw + 14
            pts = [(ax + aw, ay + ah / 2), (xm, ay + ah / 2), (xm, by + bh_ / 2), (bx, by + bh_ / 2)]
            if route == 'elbowv':
                lab = (xm + 5, (ay + by + bh_) / 2 + 6, 'v')
            else:
                lab = ((xm + bx) / 2, by + bh_ / 2, 'h')
        d = 'M' + ' L'.join(f'{px:.1f},{py:.1f}' for px, py in pts)
        (x0, y0), (x2, y2) = pts[-2], pts[-1]
        ln = max(1e-6, ((x2 - x0) ** 2 + (y2 - y0) ** 2) ** .5)
        dx, dy = (x2 - x0) / ln, (y2 - y0) / ln
        # stop the line at the arrowhead's base
        pts2 = pts[:-1] + [(x2 - dx * 7, y2 - dy * 7)]
        d = 'M' + ' L'.join(f'{px:.1f},{py:.1f}' for px, py in pts2)
        out.append(f'<path class="fl-e {k}" d="{d}"/>')
        out.append(arrow(x2, y2, dx, dy, k))
        if label:
            labels.append((lab, label, k))
    for (lx, ly, orient), label, k in labels:
        lines = label.split('\n')
        if orient == 'h':
            if len(lines) == 1:
                ys = [ly - 6]
            else:
                ys = [ly - 6, ly + 14]
            anchor = 'middle'
        else:
            ys = [ly - 6 * (len(lines) - 1) + 4 + i * 13 for i in range(len(lines))]
            anchor = 'start'
        for t, yy in zip(lines, ys):
            wpx = len(t) * 6.1 + 6
            rx = lx - wpx / 2 if anchor == 'middle' else lx - 3
            out.append(f'<rect class="fl-lb" x="{rx:.1f}" y="{yy - 10:.1f}" width="{wpx:.1f}" height="13" rx="2"/>')
            out.append(f'<text class="fl-lt {k}" x="{lx:.1f}" y="{yy:.1f}" text-anchor="{anchor}">{esc(t)}</text>')
    for k_, (c, r, ref, label, kind) in nodes.items():
        bx, by, bw, bh_ = box[k_]
        lines = label.split('\n')
        if ref in ('START', 'END'):
            h = 30
            yy = by + (bh_ - h) / 2
            out.append(f'<rect class="fl-term" x="{bx + 8}" y="{yy}" width="{bw - 16}" height="{h}" rx="15"/>')
            word = 'Start' if ref == 'START' else 'End'
            out.append(f'<text class="fl-termt" x="{bx + bw / 2}" y="{yy + 19.5}" text-anchor="middle">{word}</text>')
            for i, t in enumerate(lines):
                ty = (yy - 6 - 13 * (len(lines) - 1 - i)) if ref == 'START' and r == 0 and False else (yy + h + 13 + 12 * i)
                out.append(f'<text class="fl-t sub" x="{bx + bw / 2}" y="{ty}" text-anchor="middle">{esc(t)}</text>')
            continue
        cls = {'main': '', 'err': 'err', 'perm': 'perm', 'later': 'later', 'sys': 'perm', 'nav': 'nav'}[kind]
        num = numbers.get(ref) if ref and ref.startswith('f-') else None
        g = []
        g.append(f'<rect class="fl-box {cls}" x="{bx}" y="{by}" width="{bw}" height="{bh_}" rx="8"/>')
        ty0 = by + bh_ / 2 - (len(lines) - 1) * 7.5 + 4.5
        for i, t in enumerate(lines):
            sub = ' sub' if kind == 'nav' and i > 0 else ''
            g.append(f'<text class="fl-t{sub}" x="{bx + bw / 2}" y="{ty0 + i * 15:.1f}" text-anchor="middle">{esc(t)}</text>')
        if num is not None:
            tw = 10 + 7 * len(str(num))
            g.append(f'<rect class="fl-no" x="{bx + 8}" y="{by - 8}" width="{tw}" height="16" rx="3"/>')
            g.append(f'<text class="fl-not" x="{bx + 8 + tw / 2}" y="{by + 4}" text-anchor="middle">{num}</text>')
        body = ''.join(g)
        href = f'#{ref}' if ref and ref.startswith('f-') else (ref if ref and ref.startswith('#') else None)
        if href and (not ref.startswith('f-') or ref in numbers):
            name = f'{num} · ' if num is not None else ''
            out.append(f'<a class="fl-link" href="{href}" aria-label="{esc(name + " ".join(lines))}">{body}</a>')
        else:
            out.append(body)
    out.append('</svg>')
    svg = '\n'.join(out)
    return (f'<figure class="flow" id="{j["id"]}"><h3>{esc(j["title"])}</h3>'
            f'<div class="flow-scroll">{svg}</div><figcaption>{esc(j["caption"])}</figcaption></figure>')


LEGEND = '''<div class="legend-row" aria-label="How to read the diagrams">
<span><svg width="40" height="18" aria-hidden="true"><rect x="1" y="1" width="38" height="16" rx="4" fill="var(--paper)" stroke="var(--ink-3)"/><rect x="4" y="-1" width="16" height="10" rx="2" fill="var(--amber)"/></svg>a frame: its number, links to it</span>
<span><svg width="40" height="18" aria-hidden="true"><rect x="1" y="1" width="38" height="16" rx="4" fill="var(--paper)" stroke="var(--danger)" stroke-dasharray="4 3"/></svg>an error or offline answer</span>
<span><svg width="40" height="18" aria-hidden="true"><rect x="1" y="1" width="38" height="16" rx="4" fill="var(--paper)" stroke="var(--ink-3)" stroke-dasharray="2 3"/></svg>no permission, or not Kept's screen</span>
<span><svg width="40" height="18" aria-hidden="true"><rect x="1" y="1" width="38" height="16" rx="4" fill="var(--sunken)" stroke="var(--ink-3)" stroke-dasharray="6 4"/></svg>shown, not built yet</span>
<span><svg width="44" height="18" aria-hidden="true"><rect x="2" y="2" width="40" height="14" rx="7" fill="var(--ink)"/></svg>start and end</span>
</div>'''

# ----------------------------------------------------------------------------------------------
TOKENS = [  # name, light, dark (tokens.css)
    ('paper', '#F2F1EC', '#151412'), ('surface', '#FBFAF7', '#1E1C19'), ('sunken', '#ECEAE4', '#26231F'),
    ('line', '#DEDBD3', '#34302A'), ('ink', '#1C1B19', '#F2EFE9'), ('ink-2', '#55524C', '#BDB7AC'),
    ('ink-3', '#6B675F', '#9A948A'), ('amber', '#F0B03A', '#F0B03A'), ('amber-ink', '#2E2100', '#2E2100'),
    ('amber-text', '#8A5700', '#F4C165'), ('violet', '#5B3CC4', '#A898FA'), ('violet-soft', '#EEEAFD', '#2A2447'),
    ('ok', '#1E7B3C', '#5CC27F'), ('warn', '#A6480A', '#F28A4E'), ('danger', '#B42318', '#F97066'),
    ('info', '#2459A8', '#7FA8EE'), ('s1', '#2a78d6', '#3987e5'), ('s2', '#eb6834', '#d95926'),
    ('s3', '#1baf7a', '#199e70'), ('s-other', '#A8A399', '#6E695F'),
]
K_GLYPH = 'M277 306 204 210V0H73V698H204V384H210L291 500L438 698H586L367 404L596 0H448Z'


TAPE_CUT = ('M9 2H55A7 7 0 0 1 62 9V55A7 7 0 0 1 55 62H9A7 7 0 0 1 2 55V9A7 7 0 0 1 9 2Z'
            'M12 8.5A3.5 3.5 0 1 0 12 15.5A3.5 3.5 0 1 0 12 8.5Z')


def app_mark(size):
    """components/brand.tsx AppMark: the square of tape with its punched hole (cut out, so it shows
    the page) and a heavy mono K, at every size."""
    inner = (f'<path d="{TAPE_CUT}" fill="#F0B03A" fill-rule="evenodd"/>'
             f'<path d="{K_GLYPH}" fill="#2E2100" transform="translate(21.4 48) scale(0.042 -0.042)"/>')
    return f'<svg width="{size}" height="{size}" viewBox="0 0 64 64" aria-hidden="true">{inner}</svg>'


def kit_panel(theme):
    src = (HERE / 'kit-panel.html').read_text()
    src = re.sub(r'^<!--.*?-->\s*', '', src, flags=re.S)
    i = 1 if theme == 'light' else 2
    sw = ''.join(f'<div><i style="background:{t[i]}"></i><b>--{t[0]}</b>{t[i]}</div>' for t in TOKENS)
    icons = ''.join(f'<figure>{app_mark(s)}{s} px</figure>' for s in (16, 32, 64, 192))
    src = src.replace('{{SWATCHES}}', sw).replace('{{APPICONS}}', icons)
    label = 'Light' if theme == 'light' else 'Dark'
    return (f'<div class="kit-panel t-{theme}" aria-label="The kit, {label.lower()} theme">'
            f'<span class="eyebrow">{label}</span>{src}</div>')


KIT_DEFS = '''<svg class="k-defs" aria-hidden="true" focusable="false">
<symbol id="k-check" viewBox="0 0 24 24"><path d="m5 12.5 4.5 4.5L19 7.5"/></symbol>
<symbol id="k-x" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></symbol>
<symbol id="k-down" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></symbol>
<symbol id="k-search" viewBox="0 0 24 24"><circle cx="11" cy="11" r="6"/><path d="m20 20-4.5-4.5"/></symbol>
<symbol id="k-filter" viewBox="0 0 24 24"><path d="M4 5h16l-6 7.5V19l-4-2v-4.5z"/></symbol>
<symbol id="k-plus" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></symbol>
<symbol id="k-sort" viewBox="0 0 24 24"><path d="m21 16-4 4-4-4"/><path d="M17 20V4"/><path d="m3 8 4-4 4 4"/><path d="M7 4v16"/></symbol>
<symbol id="k-alert" viewBox="0 0 24 24"><path d="M12 4 21 19.5H3Z"/><path d="M12 10v4.5M12 17v.01"/></symbol>
<symbol id="k-info" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 8v.01"/></symbol>
<symbol id="k-checkc" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="m8.5 12.2 2.4 2.4 4.6-4.8"/></symbol>
<symbol id="k-retry" viewBox="0 0 24 24"><path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.5 4.5v4h-4"/></symbol>
<symbol id="k-inbox" viewBox="0 0 24 24"><path d="M4 13h4l2 3h4l2-3h4"/><path d="M5 13 7 5h10l2 8v6H5Z"/></symbol>
<symbol id="k-tag" viewBox="0 0 24 24"><path d="M3.5 12.1V4.5a1 1 0 0 1 1-1h7.6l8.4 8.4a1.4 1.4 0 0 1 0 2l-6 6a1.4 1.4 0 0 1-2 0z"/><circle cx="8" cy="8" r="1.4"/></symbol>
<symbol id="k-box" viewBox="0 0 24 24"><path d="m12 3.5 8 4v9l-8 4-8-4v-9Z"/><path d="m4 7.5 8 4 8-4M12 11.5v9"/></symbol>
<symbol id="k-bookmark" viewBox="0 0 24 24"><path d="M6.5 3.5h11v17L12 16.5l-5.5 4z"/></symbol>
<symbol id="k-pencil" viewBox="0 0 24 24"><path d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17Z"/><path d="m14.5 7.5 3 3"/></symbol>
<symbol id="k-chev" viewBox="0 0 24 24"><path d="m9 6 6 6-6 6"/></symbol>
<symbol id="k-x3" viewBox="0 0 24 24"><rect x="4" y="6" width="16" height="12" rx="2"/></symbol>
<symbol id="k-back" viewBox="0 0 24 24"><path d="m15 6-6 6 6 6"/></symbol>
<symbol id="k-bell" viewBox="0 0 24 24"><path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15Z"/><path d="M10 20a2 2 0 0 0 4 0"/></symbol>
<symbol id="k-home" viewBox="0 0 24 24"><path d="M4 11 12 4l8 7v8a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1Z"/></symbol>
<symbol id="k-key" viewBox="0 0 24 24"><circle cx="8" cy="15" r="4"/><path d="m11 12 8-8M16 7l2 2M14 9l2 2"/></symbol>
<symbol id="k-upload" viewBox="0 0 24 24"><path d="M12 16V4M7 9l5-5 5 5M4 16v4h16v-4"/></symbol>
<symbol id="k-cloudoff" viewBox="0 0 24 24"><path d="M7 18h10a4 4 0 0 0 .8-7.9A6 6 0 0 0 7.2 8.4 4.8 4.8 0 0 0 7 18Z"/><path d="M4 4l16 16"/></symbol>
<symbol id="k-trash" viewBox="0 0 24 24"><path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13"/></symbol>
<symbol id="k-scan" viewBox="0 0 24 24"><path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3M7 12h10"/></symbol>
</svg>'''

SCRIPT = '''<script>
(function(){
  var links = Array.prototype.slice.call(document.querySelectorAll('.toc a[href^="#"]'));
  var byId = {};
  links.forEach(function(a){ var id = a.getAttribute('href').slice(1); (byId[id] = byId[id] || []).push(a); });
  var targets = Object.keys(byId).map(function(id){ return document.getElementById(id); }).filter(Boolean);
  var current = null;
  function mark(id){
    if (id === current) return;
    if (current && byId[current]) byId[current].forEach(function(a){ a.removeAttribute('aria-current'); });
    current = id;
    if (id && byId[id]) byId[id].forEach(function(a){
      a.setAttribute('aria-current', 'true');
      var side = a.closest('.side');
      if (side) {
        var r = a.getBoundingClientRect(), s = side.getBoundingClientRect();
        if (r.top < s.top + 40 || r.bottom > s.bottom - 40) side.scrollTop += r.top - s.top - s.height / 3;
      }
    });
  }
  var lockUntil = 0;
  function onScroll(){
    if (Date.now() < lockUntil) return;
    // frames sit side by side: of those in one row, the first is current
    var line = window.innerHeight * 0.3, best = null, bestTop = null;
    for (var i = 0; i < targets.length; i++) {
      var top = targets[i].getBoundingClientRect().top;
      if (top > line) break;
      if (bestTop === null || Math.abs(top - bestTop) > 4) { best = targets[i].id; bestTop = top; }
    }
    mark(best || (targets[0] && targets[0].id));
  }
  links.forEach(function(a){
    a.addEventListener('click', function(){ lockUntil = Date.now() + 800; mark(a.getAttribute('href').slice(1)); });
  });
  var queued = false;
  window.addEventListener('scroll', function(){
    if (queued) return; queued = true;
    requestAnimationFrame(function(){ queued = false; onScroll(); });
  }, { passive: true });
  onScroll();
  // the phone's Contents closes once a link is chosen
  var m = document.querySelector('.toc-m');
  if (m) m.addEventListener('click', function(e){ if (e.target.closest('a')) m.open = false; });
})();
</script>'''


def main():
    missing, frags, order = [], [], []
    for fn, anchor, label in AREAS:
        p = HERE / fn
        if not p.exists():
            missing.append(fn)
            continue
        s = p.read_text()
        ids = re.findall(r'<figure id="(f-[a-z0-9-]+)"', s)
        order.append((anchor, label, ids))
        frags.append((fn, s))
    numbers, n = {}, 0
    for _, _, ids in order:
        for fid in ids:
            n += 1
            numbers[fid] = n
    unknown = [f for f in numbers if f not in FRAMES]
    if unknown:
        sys.exit(f'frames without an entry in FRAMES: {unknown}')

    def ref(x):
        if x in numbers:
            return f'<a href="#{x}">{numbers[x]} {esc(FRAMES[x][0])}</a>'
        if x.startswith('f-'):
            return None  # a frame not drawn (yet): leave it out
        return esc(x)

    def decorate(s):
        def one(m):
            fid, body = m.group(1), m.group(2)
            title, frm, nxt = FRAMES[fid]
            body = body.replace('<figcaption class="frame-cap">',
                                f'<figcaption class="frame-cap"><span class="fno">{numbers[fid]}</span>', 1)
            f = [r for r in map(ref, frm) if r]
            t = [r for r in map(ref, nxt) if r]
            parts = []
            if f:
                parts.append('From: ' + ', '.join(f))
            if t:
                parts.append('Next: ' + ', '.join(t))
            nav = f'<p class="frame-links">{" · ".join(parts)}</p>' if parts else ''
            return f'<figure id="{fid}"{body}{nav}</figure>'
        return re.sub(r'<figure id="(f-[a-z0-9-]+)"(.*?)</figure>', one, s, flags=re.S)

    body = [decorate(s) for _, s in frags]

    # sidebar
    toc = ['<div class="toc">',
           '<div><h2>Start here</h2><ol><li><a class="area-link" href="#flows">Flow map</a></li></ol></div>']
    for anchor, label, ids in order:
        items = ''.join(f'<li><a href="#{f}"><span class="n">{numbers[f]}</span><span>{esc(FRAMES[f][0])}</span></a></li>'
                        for f in ids)
        toc.append(f'<div><h2><a class="area-link" href="#{anchor}" style="padding:0">{esc(label)}</a></h2><ol>{items}</ol></div>')
    toc.append('<div><h2>Reference</h2><ol><li><a class="area-link" href="#kit">The kit, light and dark</a></li></ol></div>')
    toc.append('</div>')
    toc = ''.join(toc)

    flows = ['<section class="flows" id="flows"><header><span class="eyebrow">Start here</span>'
             '<h2>Flow map</h2><p>Seven journeys and the navigation map, drawn from the screens spec §6 and the built app. '
             'Each numbered box is a frame on this page and links to it; the same numbers run down the sidebar.</p></header>',
             LEGEND]
    flows += [draw(j, numbers) for j in JOURNEYS]
    flows.append(draw(NAVMAP, numbers))
    flows.append('</section>')

    kit = ('<section class="kit" id="kit"><header class="sec-head"><span class="eyebrow">Reference</span>'
           '<h2>The kit, as built</h2><p>Tokens and components copied from the app itself: '
           '<code>styles/tokens.css</code>, <code>styles/index.css</code>, <code>components/ui/*</code>, '
           '<code>components/page.tsx</code>, <code>components/filters/*</code> and <code>components/brand.tsx</code>. '
           'The same panel twice, forced light and forced dark. Frames above use only these pieces.</p></header>'
           f'<div class="kit-pair">{kit_panel("light")}{kit_panel("dark")}</div></section>')

    kitcss = (HERE / 'kit.css').read_text()
    head = f'''<title>Kept Screens</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@500;600&family=IBM+Plex+Sans+Arabic:wght@400;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap">
<style>
{kitcss}
</style>
{KIT_DEFS}
<div class="board">
<aside class="side" aria-label="Frames">
  <div class="lockup"><svg width="84" height="28.1" viewBox="0 0 191 64" role="img" aria-label="Kept"><path d="M9 2H55A7 7 0 0 1 62 9V55A7 7 0 0 1 55 62H9A7 7 0 0 1 2 55V9A7 7 0 0 1 9 2ZM12 8.5A3.5 3.5 0 1 0 12 15.5A3.5 3.5 0 1 0 12 8.5Z" fill="#F0B03A" fill-rule="evenodd"/><path d="M277 306 204 210V0H73V698H204V384H210L291 500L438 698H586L367 404L596 0H448Z" fill="#2E2100" transform="translate(21.4 48) scale(0.042 -0.042)"/><g fill="var(--ink)"><path d="M277 306 204 210V0H73V698H204V384H210L291 500L438 698H586L367 404L596 0H448Z" transform="translate(74 48) scale(0.042 -0.042)"/><path d="M83 0V698H524V590H214V408H513V300H214V108H524V0Z" transform="translate(104.2 48) scale(0.042 -0.042)"/><path d="M80 0V698H345Q447 698 501 640Q555 582 555 482Q555 382 501 324Q447 266 345 266H211V0ZM211 373H318Q371 373 394 394.5Q417 416 417 463V501Q417 548 394 569.5Q371 591 318 591H211Z" transform="translate(134.4 48) scale(0.042 -0.042)"/><path d="M365 590V0H235V590H25V698H575V590Z" transform="translate(164.6 48) scale(0.042 -0.042)"/></g></svg><span>Screens · {n} frames</span></div>
  <nav aria-label="Frames on this page">{toc}</nav>
</aside>
<main class="board-main">
<header class="mast">
  <div class="lock">
    <svg width="120" height="40.2" viewBox="0 0 191 64" role="img" aria-label="Kept"><path d="M9 2H55A7 7 0 0 1 62 9V55A7 7 0 0 1 55 62H9A7 7 0 0 1 2 55V9A7 7 0 0 1 9 2ZM12 8.5A3.5 3.5 0 1 0 12 15.5A3.5 3.5 0 1 0 12 8.5Z" fill="#F0B03A" fill-rule="evenodd"/><path d="M277 306 204 210V0H73V698H204V384H210L291 500L438 698H586L367 404L596 0H448Z" fill="#2E2100" transform="translate(21.4 48) scale(0.042 -0.042)"/><g fill="var(--ink)"><path d="M277 306 204 210V0H73V698H204V384H210L291 500L438 698H586L367 404L596 0H448Z" transform="translate(74 48) scale(0.042 -0.042)"/><path d="M83 0V698H524V590H214V408H513V300H214V108H524V0Z" transform="translate(104.2 48) scale(0.042 -0.042)"/><path d="M80 0V698H345Q447 698 501 640Q555 582 555 482Q555 382 501 324Q447 266 345 266H211V0ZM211 373H318Q371 373 394 394.5Q417 416 417 463V501Q417 548 394 569.5Q371 591 318 591H211Z" transform="translate(134.4 48) scale(0.042 -0.042)"/><path d="M365 590V0H235V590H25V698H575V590Z" transform="translate(164.6 48) scale(0.042 -0.042)"/></g></svg>
    <div><h1 style="font-size:22px">Screens</h1><p>What Kept looks like, phone and desktop, light, dark and Arabic: {n} frames of the built app and the decided screens. The design choices behind them are on the <a href="kept-design-board.html">design board</a>.</p></div>
  </div>
</header>
<details class="toc-m"><summary>Contents · {n} frames</summary><nav aria-label="Frames on this page, phone">{toc}</nav></details>
'''
    out = head + '\n'.join(flows) + '\n' + '\n'.join(body) + '\n' + kit + '\n</main>\n</div>\n' + SCRIPT + '\n'
    tmp = OUT.with_suffix('.html.tmp')
    tmp.write_text(out)
    os.replace(tmp, OUT)
    print('assembled', len(frags), 'areas,', n, 'frames; missing:', missing, 'bytes', len(out))


if __name__ == '__main__':
    main()
