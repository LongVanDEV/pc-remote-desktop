# PC Remote Desktop

A small, self-built remote desktop tool. Sign in with your Google
account; every PC you run it on registers itself as a device under
that account; pick any of them from your **My PCs** list and connect —
no codes, no typing, every time. It can also auto-start in the Windows tray and auto-host this PC in the background. It's one Electron app with three
screens (Launcher/dashboard, Host, Viewer), using:

- **Electron** — desktop app shell (Chromium + Node), gives you real
  `getUserMedia`/`WebRTC` in the renderer and screen capture via
  `desktopCapturer`.
- **Supabase Auth (Google OAuth)** — sign-in. Runs through your
  system's default browser (Google blocks OAuth inside Electron's
  built-in webview), with the result caught by a small local server
  the app spins up temporarily on your own machine.
- **Supabase Postgres** — a `devices` table (one row per PC you've
  hosted from), a `paired_viewers` table (who else is allowed to
  connect to a given device), and `device_invites` (one-time codes
  used only to add a *new* paired account).
- **Supabase Realtime** — used only for *signaling*: the brief
  handshake where two PCs exchange WebRTC connection info before a
  direct peer-to-peer link forms. Each device has its own stable,
  private channel (`room-<device id>`) — no video or input data passes
  through Supabase.
- **PowerShell + Win32 (`user32.dll`)** — on the host PC, a small
  persistent PowerShell process (spawned by the app, using .NET's
  `Add-Type` to call `mouse_event`/`keybd_event`) turns incoming
  mouse/keyboard messages into real OS-level input. No native Node
  module, no compiler, no Visual Studio needed.
- **Background mode** — optional Windows-login startup, system-tray
  operation, and silent auto-hosting.
- **Persistent host history** — the last 500 local host events are kept
  on disk in the app data directory.
- **Clipboard sync** — text clipboard changes are synchronized over the
  existing WebRTC data channel.
- **Monitor + stream controls** — choose a display and a 720p/1080p/1440p
  or 60 FPS capture preset.
- **WebRTC ICE redundancy** — Cloudflare and multiple Google STUN servers
  are configured instead of relying on a single STUN endpoint.

## Updated features

This build includes persistent refresh-token storage, Windows tray/startup
background hosting, Cloudflare + Google STUN redundancy, persistent host
history, server-backed invite-code rate limiting, clipboard sync, monitor
selection, stream-quality presets, and the NSIS auto-update integration.

## 1. Create a Supabase project

1. Go to supabase.com → New project (free tier is enough).
2. In **Project Settings → API**, copy the **Project URL** and the
   **anon public** key. Paste them into `src/renderer/config.js` on
   **every** PC that will run this app:

   ```js
   module.exports = {
     SUPABASE_URL: 'https://YOUR-PROJECT.supabase.co',
     SUPABASE_ANON_KEY: 'YOUR-ANON-PUBLIC-KEY',
     LOOPBACK_PORT: 53682
   };
   ```

3. In the **SQL Editor**, run this once. It's fully idempotent —
   creates whatever's missing, adds any missing columns, and replaces
   older/broken policies — so it's safe to run even if you've already
   run earlier versions of this schema, including a partially-applied
   or hand-patched one:

   ```sql
   -- 1. Tables (create if missing; add any columns that might be missing)
   create table if not exists devices (
     id uuid primary key,
     owner_user_id uuid not null references auth.users(id),
     name text not null default 'My PC',
     last_seen timestamptz,
     created_at timestamptz not null default now()
   );

   create table if not exists paired_viewers (
     id uuid primary key default gen_random_uuid(),
     device_id uuid not null references devices(id) on delete cascade,
     viewer_email text not null,
     created_at timestamptz not null default now(),
     unique (device_id, viewer_email)
   );

   create table if not exists device_invites (
     code text primary key,
     device_id uuid not null references devices(id) on delete cascade,
     created_at timestamptz not null default now(),
     expires_at timestamptz not null default (now() + interval '10 minutes'),
     redeemed_at timestamptz
   );

   create table if not exists invite_redeem_attempts (
     user_id uuid primary key references auth.users(id) on delete cascade,
     failed_attempts integer not null default 0,
     window_started_at timestamptz not null default now(),
     blocked_until timestamptz
   );

   create table if not exists bans (
     id uuid primary key default gen_random_uuid(),
     owner_user_id uuid not null references auth.users(id),
     kind text not null check (kind in ('email', 'hwid', 'ip')),
     value text not null,
     reason text,
     created_at timestamptz not null default now()
   );
   alter table bans add column if not exists device_id uuid references devices(id) on delete cascade;
   alter table bans add column if not exists is_global boolean not null default false;

   create table if not exists admins (
     user_id uuid primary key references auth.users(id)
   );

   alter table devices enable row level security;
   alter table paired_viewers enable row level security;
   alter table device_invites enable row level security;
   alter table invite_redeem_attempts enable row level security;
   alter table bans enable row level security;
   alter table admins enable row level security;
   -- admins has NO policies on purpose — unreachable from the app,
   -- only editable via this SQL editor.

   -- 2. Helper functions. SECURITY DEFINER means these run bypassing
   -- RLS on the table they check — this is what breaks the circular
   -- "devices policy queries paired_viewers, which queries devices"
   -- recursion you'd otherwise hit with plain cross-table subqueries.
   create or replace function public.is_device_owner(check_device_id uuid)
   returns boolean
   language sql
   security definer
   set search_path = public
   stable
   as $$
     select exists (
       select 1 from devices d
       where d.id = check_device_id and d.owner_user_id = auth.uid()
     );
   $$;
   grant execute on function public.is_device_owner(uuid) to authenticated;

   create or replace function public.is_paired_viewer(check_device_id uuid)
   returns boolean
   language sql
   security definer
   set search_path = public
   stable
   as $$
     select exists (
       select 1 from paired_viewers pv
       where pv.device_id = check_device_id and pv.viewer_email = auth.jwt() ->> 'email'
     );
   $$;
   grant execute on function public.is_paired_viewer(uuid) to authenticated;

   create or replace function public.is_admin()
   returns boolean
   language sql
   security definer
   set search_path = public
   stable
   as $$
     select exists (select 1 from admins where user_id = auth.uid());
   $$;
   grant execute on function public.is_admin() to authenticated;

   -- 3. Policies — dropped and recreated cleanly using the helper
   -- functions above instead of raw cross-table subqueries.
   drop policy if exists "owner manages own devices" on devices;
   drop policy if exists "paired viewers can see shared devices" on devices;
   create policy "owner manages own devices"
   on devices for all
   to authenticated
   using (owner_user_id = auth.uid())
   with check (owner_user_id = auth.uid());
   create policy "paired viewers can see shared devices"
   on devices for select
   to authenticated
   using (is_paired_viewer(id));

   drop policy if exists "device owner manages pairing for their device" on paired_viewers;
   drop policy if exists "viewer can see their own pairing rows" on paired_viewers;
   create policy "device owner manages pairing for their device"
   on paired_viewers for all
   to authenticated
   using (is_device_owner(device_id))
   with check (is_device_owner(device_id));
   create policy "viewer can see their own pairing rows"
   on paired_viewers for select
   to authenticated
   using (viewer_email = auth.jwt() ->> 'email');

   drop policy if exists "device owner manages invites for their device" on device_invites;
   drop policy if exists "any authenticated user can look up an unredeemed unexpired invite" on device_invites;
   create policy "device owner manages invites for their device"
   on device_invites for all
   to authenticated
   using (is_device_owner(device_id))
   with check (is_device_owner(device_id));
   create policy "any authenticated user can look up an unredeemed unexpired invite"
   on device_invites for select
   to authenticated
   using (redeemed_at is null and expires_at > now());

   drop policy if exists "owner manages their own bans" on bans;
   drop policy if exists "read own or global bans" on bans;
   drop policy if exists "insert own or admin-global bans" on bans;
   drop policy if exists "update own or admin-global bans" on bans;
   drop policy if exists "delete own or admin-global bans" on bans;
   create policy "read own or global bans"
   on bans for select
   to authenticated
   using (owner_user_id = auth.uid() or is_global = true);
   create policy "insert own or admin-global bans"
   on bans for insert
   to authenticated
   with check (
     (owner_user_id = auth.uid() and is_global = false)
     or (is_global = true and is_admin())
   );
   create policy "update own or admin-global bans"
   on bans for update
   to authenticated
   using (owner_user_id = auth.uid() or (is_global and is_admin()))
   with check (owner_user_id = auth.uid() or (is_global and is_admin()));
   create policy "delete own or admin-global bans"
   on bans for delete
   to authenticated
   using (owner_user_id = auth.uid() or (is_global and is_admin()));

   -- 4. Invite redemption (SECURITY DEFINER so a non-owner can redeem)
   -- The server-side attempt table makes code guessing expensive even
   -- if somebody bypasses the desktop client's local throttle.
   create or replace function redeem_device_invite(invite_code text)
   returns devices
   language plpgsql
   security definer
   set search_path = public
   as $$
   declare
     inv device_invites;
     dev devices;
     uid uuid := auth.uid();
     attempts invite_redeem_attempts;
     now_ts timestamptz := now();
     next_failures integer;
   begin
     if uid is null then
       raise exception 'You must be signed in';
     end if;

     insert into invite_redeem_attempts(user_id) values (uid)
       on conflict (user_id) do nothing;

     select * into attempts
       from invite_redeem_attempts
       where user_id = uid
       for update;

     if attempts.window_started_at + interval '15 minutes' <= now_ts then
       attempts.failed_attempts := 0;
       attempts.window_started_at := now_ts;
       attempts.blocked_until := null;
     end if;

     if attempts.blocked_until is not null and attempts.blocked_until > now_ts then
       raise exception 'Too many invalid invite attempts. Try again later.';
     end if;

     select * into inv from device_invites
       where code = upper(trim(invite_code))
         and redeemed_at is null
         and expires_at > now_ts;

     if not found then
       next_failures := attempts.failed_attempts + 1;
       update invite_redeem_attempts
         set failed_attempts = next_failures,
             window_started_at = attempts.window_started_at,
             blocked_until = case
               when next_failures >= 8 then now_ts + interval '15 minutes'
               else null
             end
         where user_id = uid;
       raise exception 'Invalid or expired invite code';
     end if;

     insert into paired_viewers (device_id, viewer_email)
       values (inv.device_id, auth.jwt() ->> 'email')
       on conflict (device_id, viewer_email) do nothing;

     update device_invites set redeemed_at = now_ts where code = inv.code;
     update invite_redeem_attempts
       set failed_attempts = 0, window_started_at = now_ts, blocked_until = null
       where user_id = uid;

     select * into dev from devices where id = inv.device_id;
     return dev;
   end;
   $$;
   grant execute on function redeem_device_invite(text) to authenticated;

   -- 5. Realtime gate: require a signed-in session for any channel use
   drop policy if exists "authenticated users can use realtime broadcast" on realtime.messages;
   create policy "authenticated users can use realtime broadcast"
   on realtime.messages for all
   to authenticated
   using ( true )
   with check ( true );

   -- 6. Make yourself an admin (edit the email). Safe to re-run —
   -- no-ops if you're already in the table.
   insert into admins (user_id)
   select id from auth.users where email = 'YOUR-GOOGLE-EMAIL@example.com'
   on conflict (user_id) do nothing;
   ```

4. **Authentication → Providers → Google** — enable it (Client
   ID/Secret from Google Cloud Console, next step).
5. **Authentication → URL Configuration → Additional Redirect URLs**
   — add `http://127.0.0.1:53682/callback` (match whatever
   `LOOPBACK_PORT` you set in `config.js`).
6. **Realtime → Settings** — turn **off** "Allow public access" (this
   is what actually enforces the private-channel/RLS model above
   instead of falling back to public channels).

## 2. Set up the Google OAuth client

1. Google Cloud Console → **APIs & Services → OAuth consent screen**
   — set it up as External, add yourself as a test user if it's still
   in Testing mode.
2. **Credentials → Create Credentials → OAuth client ID** → type
   **Web application**.
3. Under **Authorized redirect URIs**, add:
   `https://<your-project-ref>.supabase.co/auth/v1/callback`
4. Copy the **Client ID** and **Client Secret** into Supabase's
   Authentication → Providers → Google settings from step 1.4 above.

## 3. Install and run

No Python, no Visual Studio, no build tools — just Node.js (LTS).

```bash
npm install
npm start
```

- Sign in with Google on the main window. You'll see your **My PCs**
  list (empty at first).
- Click **"Host this PC"** on any machine to register it as a device
  under your account and start listening for connections.
- On another PC (or the same one, in a second window), sign in with
  the **same** Google account, and that hosted PC shows up in your
  My PCs list automatically — click **Connect**. No code needed.
- To let a **different** Google account connect to one of your PCs:
  on the host window, click **"Generate invite code"** and share the
  6-character code (out of band — chat, text, whatever). The other
  person signs in, pastes it into **"Add a PC"** on their dashboard,
  and your PC appears in *their* list from then on — the code is
  single-use and expires in 10 minutes; nothing is typed again after
  that.
- Click the **⚙ gear icon** next to any PC you own to open its
  **Manage** screen: see everyone with access, **Remove** (just
  revokes — they'd need a new invite to come back) or **Ban** them
  (revokes *and* blocks that email from ever redeeming another
  invite), ban an email/HWID/IP pre-emptively before anyone connects,
  **Unban**, or **Remove this PC** entirely. If your account is in the
  `admins` table (set by hand in SQL — see below), an extra **"Entire
  network"** scope appears in the ban form, blocking that value across
  every device in the project, not just ones you own.

> Hosting (receiving control) only works on **Windows**, since input
> injection goes through PowerShell + `user32.dll`. Viewing works from
> any OS Electron runs on, though this project is set up as a Windows
> app end to end.

## How the connection works

1. Each host PC has a stable `device_id` (generated once, stored
   locally) and a matching private Realtime channel `room-<device_id>`
   that it stays subscribed to the whole time it's hosting.
2. When you click Connect on a device, the viewer joins that same
   channel and broadcasts `viewer-ready`, including your signed-in
   Google account's id/email, plus a hardware id (motherboard UUID,
   read via PowerShell/WMI) and your public IP (self-reported, via a
   lookup the viewer makes itself).
3. The host checks bans first — email, HWID, or IP, either scoped to
   this device or set to apply everywhere. Any match, ignored,
   full stop. Otherwise: is this you (same account, another install)
   or an account already in `paired_viewers` for this device? If yes,
   it immediately captures its screen, creates a WebRTC offer (video
   track + an `input` data channel), and broadcasts it — no prompt, no
   code. If neither, it's ignored.
4. From there, ICE candidates are exchanged until a direct WebRTC
   connection forms. Video flows host → viewer, input events flow
   viewer → host over the data channel, and text clipboard changes are
   synchronized in both directions over that same data channel. The host
   applies the selected monitor and stream-quality preset before sending
   the video track.

## Background mode and automatic updates

On the dashboard, **Start with Windows** registers the packaged app as a
Windows login item. **Auto-host in background** makes the app start a hidden
host window and stay available from the system tray. The tray menu can open
the dashboard, start/stop hosting, toggle those settings, and check for an
update. Closing the dashboard hides it to the tray; use **Quit** in the tray
menu to fully exit.

Automatic updates use `electron-updater` with the NSIS build and GitHub Releases.
The GitHub owner/repository is configured in `package.json` under `build.publish`
and is embedded into packaged builds as the update configuration. The updater
checks the `latest` GitHub release and downloads the matching Windows NSIS
installer metadata. The portable target is not auto-updatable, so use the NSIS
installer for managed updates. Never put your GitHub publishing token in
`src/renderer/config.js` or any source file; keep it in the `GH_TOKEN`
environment variable only. See `GITHUB_UPDATE_GUIDE.md` for the exact release
steps. For production, code-sign the Windows installer so users can validate
the publisher of downloaded updates.

## 4. Package it as a .exe

```bash
npm run dist
```

Produces, in `dist/`:
- `PC Remote Desktop Setup <version>.exe` — installer (NSIS)
- `PC Remote Desktop <version>.exe` — portable, no-install version

Either is fully self-contained (Electron runtime + `@supabase/supabase-js`
bundled in) — whoever runs it needs nothing installed. No native
module in this build, so packaging needs no compiler either.

Notes:
- First run of `npm run dist` needs internet access (downloads the
  Electron binary + NSIS tooling once, then caches them).
- `electron` lives in `devDependencies`, not `dependencies` — that's
  correct; `electron-builder` packages the real runtime separately.
- To ship a custom installer icon, add `build/icon.ico` (256×256) and set
  `"icon": "build/icon.ico"` under `"win"` in `package.json`'s `build`
  config. The tray icon used by background mode is `src/tray-icon.png`.
- The project uses `electron-updater` 6.8.x for the update path. GitHub update
  checks are active only in packaged Windows builds and require a published
  GitHub release for the configured repository.

## Known limitations / things to harden further

- **No TURN server.** The app now uses Cloudflare plus multiple Google
  STUN servers. That improves ICE candidate discovery, but STUN still
  does not relay traffic. Two PCs behind restrictive/symmetric NATs may
  still fail to connect directly; add a TURN service for the strongest
  internet-wide connectivity.
- **The Realtime RLS policy isn't scoped per device.** The
  `"authenticated users can use realtime broadcast"` policy blocks
  fully unauthenticated access, but any signed-in user who somehow
  learns/guesses a `device_id` could still join that channel — the
  app-layer check in `host.js` (owner-or-paired-only) is what actually
  stops them from getting a connection, not the DB policy. For
  stronger defense-in-depth, replace that policy with the
  topic-scoped version below (and drop the simpler one):

  ```sql
  create policy "only owner or paired viewer can use this device's channel"
  on realtime.messages for all
  to authenticated
  using (
    exists (
      select 1 from devices d
      where 'room-' || d.id::text = realtime.topic()
        and (
          d.owner_user_id = auth.uid()
          or exists (
            select 1 from paired_viewers pv
            where pv.device_id = d.id and pv.viewer_email = auth.jwt() ->> 'email'
          )
        )
    )
  );
  ```
- **`nodeIntegration: true` / `contextIsolation: false`** keeps this
  prototype's code simple (renderer scripts `require()` directly). For
  a hardened build, move `ipcRenderer` calls behind a `contextBridge`
  preload script instead.
- **Single monitor only.** `startCapture()` grabs the first screen
  source; extend it with a picker if a host has multiple monitors.
- **Keyboard coverage.** `keyToVk()` in `main.js` maps letters,
  digits, arrows, function keys, and common special keys. A few rare
  keys aren't mapped — add them to `VK_SPECIAL` if you hit one.
- **HWID/IP bans are self-reported, not hardened security.** The
  viewer's own app reads its motherboard UUID and looks up its own
  public IP, then sends both along honestly. A technically capable
  banned person could edit the app to lie about either (or use a VPN
  for the IP). Treat bans as moderation — like a Discord ban — not as
  an unbypassable lock. Email bans are the strongest of the three,
  since they're tied to redeeming a real Google account sign-in via
  Supabase Auth, not a self-reported client value.
- Only use this against machines you own or have explicit permission
  to access and control.
