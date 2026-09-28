# Telephone (ArozOS desktop app)

**Telephone** shows the phone number assigned to the box, lets the owner save **their mobile** (SMS approvals + voice greeting), and view/change the spoken **think passphrase** used on inbound PSTN calls.

Related: [`vps-sandbox/twilio-self-host.md`](vps-sandbox/twilio-self-host.md) (buy number + wire Twilio) · [`vps-sandbox/voice-realtime.md`](vps-sandbox/voice-realtime.md) · [`vps-sandbox/voice-think-speak.md`](vps-sandbox/voice-think-speak.md). SMS / A2P: see [twilio-self-host.md](vps-sandbox/twilio-self-host.md).

---

## Stack

| Layer | Path |
|-------|------|
| Desktop UI | `apps/telephone/` → `dist/telephone/` → `arozos/subservice/telephone/app/` |
| ArozOS subservice | `arozos/subservice/telephone/` |
| REST API | `src/telephoneSettings/` → `/joshu/api/telephone` |
| Owner override | `.joshu/telephone/settings.json` (under the Aroz user on the shared `joshu_arozos` volume) |
| Provision env | `TWILIO_PHONE_NUMBER`, `TWILIO_THINK_PASSWORD` in `/etc/joshu/instance.env` |
| Runtime readers | Joshu (`telephoneSettings/resolve.ts`) + voice-realtime (`thinkPassword.ts`) |

**Display name:** **Telephone**. Icon: `img/joshu/telephone.png` — GNOME `call-start` handset (CC BY-SA 3.0 US); Tango has no phone glyph, so this icon is **not** produced by `build-arozos-desktop-file-icons.sh`. See [`THIRD_PARTY.md`](THIRD_PARTY.md#design-assets).

---

## Behavior

### Phone number

From `TWILIO_PHONE_NUMBER` (set in `instance.env` after you buy a Twilio number — see [`twilio-self-host.md`](vps-sandbox/twilio-self-host.md)) or an optional override in `settings.json`. Displayed as a formatted number; copy uses E.164. Managed fleet boxes get this at provision.

**SMS:** the same number can send/receive SMS when A2P 10DLC is registered on the owning Twilio account ([Twilio A2P quickstart](https://www.twilio.com/docs/messaging/compliance/a2p-10dlc/quickstart)). Owner chat replies are GSM-folded and capped at 640 characters (Twilio **30019** on longer UCS-2 essays). Short **Y** / **N** / **ok** is action-guard approval; “Ok on …” in a sentence is chat. Managed fleet: private per-box runbook managed fleet A2P runbook (not in OSS). OSS self-host: [`twilio-self-host.md`](vps-sandbox/twilio-self-host.md) (SMS gateway env + SmsUrl).

### Owner mobile

Your cell — not the box number. Used as the inbound SMS allowlist and for the owner vs guest voice greeting.

Precedence: settings file `ownerCaller` → `TWILIO_OWNER_CALLER` in `instance.env` → process env. Saving in Telephone takes effect immediately (no stack recreate). Welcome **Schedule & email** writes the same field on complete.

Existing boxes that never had `TWILIO_OWNER_CALLER`: open **Telephone** and save a mobile. Action-guard SMS stays off until this is set *and* Twilio SMS is wired.

### Think passphrase

Every call — inbound or a Joshu callback — asks for this phrase (or the keypad PIN) before the assistant joins; there is no ungated mode. **Three incorrect attempts hang up** the call (silence and fillers do not count). Full call UX: [voice-realtime.md — Call gate](vps-sandbox/voice-realtime.md#call-gate-passphrase--pin).

Owner can change it in the app:

- **Show / Hide** reveals the currently configured passphrase (from settings file or env).
- **New passphrase** is always empty on load and after save — never prefilled with the live secret. **Save passphrase** stays disabled until the field is non-empty.
- On save, the override is written to `.joshu/telephone/settings.json` and read by Joshu + voice-realtime on the **next inbound call** (no stack recreate required for the override path).

Precedence for phone number, owner mobile, and passphrase: settings file → `instance.env` → process env.

### Choosing a phrase the phone can hear

Matching is fuzzy **and phonetic** (`quartz` heard as `Courts` still unlocks). It cannot rescue a phrase the transcriber never gets close to. Short words get absorbed into their neighbours over a phone line: one box configured with `swift olive` had it transcribed as `Swallowed all of` and `Swift Home`, so the call never unlocked. Prefer **two clear, distinct, multi-syllable words** (`harbor lantern`, `copper canyon`). The gate primes Twilio's recognizer with the passphrase words. If unlock keeps failing, `gate wrong entry … heardPreview` in the `voice-realtime` logs shows what was actually heard — or set a keypad PIN.

If no passphrase is configured anywhere, PSTN stays disabled (routes not registered; media streams rejected).

### Keypad PIN and verified caller ID (call gate)

Both are checked by the call gate before any model joins the call ([voice-realtime.md — Call gate](vps-sandbox/voice-realtime.md#call-gate-passphrase--pin)).

- **Keypad PIN** — 4–8 digits (6 recommended); repeated or sequential PINs are refused. Stored only as a salted scrypt hash (`pinHash`, `pinLength`); the API never returns it. Callers can key it in instead of saying the passphrase. Ten wrong PINs across calls within an hour disable the keypad for that hour.
- **Skip the passphrase from my phone** (`trustVerifiedCallerId`, default off) — a call from the owner mobile whose caller ID the carrier fully verified (STIR/SHAKEN "A") is let straight in. Anyone holding the owner's unlocked phone gets in too. Joshu's own callbacks always ask.

---

## API

| Method | Path | Notes |
|--------|------|-------|
| `GET` | `/joshu/api/telephone` | Status: box number, owner mobile, passphrase (for Show), configured flags, sources |
| `PUT` | `/joshu/api/telephone` | Body: `{ thinkPassword?: string, phoneNumber?: string, ownerCaller?: string, pin?: string, trustVerifiedCallerId?: boolean }` — empty `ownerCaller` clears the settings-file override; empty `pin` removes the PIN |

---

## Dev / hotpatch

```bash
npm run dev:telephone      # Vite :3012
npm run build:telephone
bash scripts/hotpatch-telephone.sh root@your-box.example.com
# optional: also write TWILIO_PHONE_NUMBER into instance.env
bash scripts/hotpatch-telephone.sh root@your-box.example.com +15551234567
```

After hotpatch, hard-refresh the ArozOS desktop and open **Telephone**.
