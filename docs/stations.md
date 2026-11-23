# Floor stations

A **station** is a shared tablet (or desktop) on the warehouse floor. Nobody signs in on it personally. Staff
walk up, tap their name and enter their PIN, or scan their badge, and work as themselves. Every action records
both the person and the station. The rules are in [SPEC-identity](specs/SPEC-identity.md); this page is the
how-to.

## How it works

- **The device is trusted, not the person.** When an admin sets up a station, the device gets a long-lived,
  httpOnly cookie (`woolrus_station`, 400 days). Only its hash is in the database. That cookie is what lets the
  device show the lock screen, so a 6-digit PIN only works on devices an admin approved.
- **People unlock it.** The lock screen shows a tile for every active user with a PIN. Unlocking with a PIN or a
  badge switches the station to that person, and the next person can switch onto it at any time. Permissions
  are the person's roles, nothing more.
- **It locks itself.** After the idle-lock time (`stationIdleLockMinutes` in Settings, 10 minutes by default)
  the server locks the station. Staff can also tap **Lock** in the nav.
- **Wrong PINs lock the PIN, not the station.** Five wrong PINs lock that person's PIN for 15 minutes on every
  station.

## Set up a new station

You need an Admin account and your own signed-in phone or desktop. You never sign in on the tablet.

1. **On your own device**, open **Stations**, choose **Add station**, type a name (say "Pack 3") and choose
   **Get a setup code**. You get:
   - a code like `7KQ4M-XD2RA`,
   - a QR code of the setup link,
   - a 10-minute countdown.
2. **On the tablet**, open Woolrus. On the sign-in page, tap **Set up this device as a station**. Then either:
   - scan the QR code with the tablet's camera, which opens the setup page with the code filled in, or
   - type the code. Case, spaces and dashes don't matter.
3. Tap **Set up**. The tablet shows the "Pack 3" lock screen, and your dialog changes to **Pack 3 is set up**.

Setting up several tablets? Issue one code per tablet. Up to 5 can be open at once, so you can issue them all
before you walk the floor.

If the timer runs out, choose **Get a new code** in the same dialog. Codes you issued but haven't used are listed
under the stations table as **Open setup codes**, and you can **Cancel** any of them there.

**Make this device a station** still works too, if you're already signed in on the device itself. It signs you
out there and turns the device into a station.

### Before the first station: give people a way in

A station is only useful once staff can unlock it. On **Users**:

- **Set PIN** gives a user a 6-digit PIN. Use **Generate** and hand it over; it isn't shown again.
- **Issue badge** prints a QR badge. Station tablets read it with a USB or Bluetooth scanner, which types the
  code and presses Enter.
- **Add station user** is for staff with no email address. They get a name, roles and a PIN, and can only
  unlock stations, never sign in personally or be an Admin.

## Managing stations

On **Stations** you can see each station's current user and when it was last used, and:

- **Rename** it.
- **Revoke** it: the device goes back to the sign-in page and whoever is on it is locked out. Do this for a lost,
  stolen or retired tablet.

To move a station to a different tablet, or re-pair one, revoke the old station and set up a new one. A device
that is still an active station refuses a new setup code ("That device is already a station"), so revoke it
first.

## Troubleshooting

| What you see | Why, and what to do |
|---|---|
| "That code doesn't work" | The code is wrong, already used, cancelled or expired (10 minutes). Codes also stop working if the admin who issued them was deactivated or lost the Admin role. Get a new code. |
| "There's already a station with that name" | Another station, or another open code, already uses that name. Pick another, or cancel the open code. |
| "There are already 5 open setup codes" | Use or cancel one under **Open setup codes** first. |
| "Register a station from your own sign-in" | You're unlocked on a station with your PIN. Issue codes from your own phone or desktop instead. |
| "That device is already a station" | Revoke its station on **Stations**, then set it up again. |
| The QR code opens the wrong address | The link uses `BETTER_AUTH_URL`. Set it to the address the tablets use, e.g. `https://woolrus.<your domain>`. |
| The tablet shows the sign-in page, not the lock screen | Its station was revoked, or its cookies were cleared. Set it up again. |

## Why setup codes, and not a shared secret

A static secret (a hidden URL or a value from `.env`) would never expire. Anyone who saw it once could turn any
browser into a station and start guessing PINs against every user's tile. A setup code is one admin's approval
for one named station:

- It works once and expires after 10 minutes.
- It's stored only as a hash, and it never appears in logs or audit rows.
- Only a personal Admin session can issue one, not an Admin unlocked on a station.
- Wrong, used and expired codes all look the same.
- The setup endpoint only accepts requests from Woolrus's own pages.
- At 50 bits, guessing an open code within its 10 minutes isn't realistic.

The full reasoning is in SPEC-identity, decisions 24–30.
