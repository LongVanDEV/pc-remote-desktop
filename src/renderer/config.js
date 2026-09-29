// Fill these in from your Supabase project (Settings -> API).
// The anon/public key is safe to ship in a client app — it only allows
// what your Realtime/Row-Level-Security rules permit.

// STUN finds your public address; TURN *relays* media when direct P2P fails
// (symmetric NAT, strict firewalls, some mobile hotspots). Leave the TURN
// block empty until you add credentials from a provider (Metered free tier,
// Cloudflare Calls, Twilio, or self-hosted coturn). Both host and viewer
// must use the same ICE list.
const ICE_SERVERS = [
  // Cloudflare public STUN
  { urls: 'stun:stun.cloudflare.com:3478' },
  // Google public STUN
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  // --- Optional TURN (uncomment and fill after you create a TURN account) ---
  // {
  //   urls: [
  //     'turn:YOUR_TURN_HOST:3478?transport=udp',
  //     'turn:YOUR_TURN_HOST:3478?transport=tcp',
  //     'turns:YOUR_TURN_HOST:5349?transport=tcp'
  //   ],
  //   username: 'YOUR_TURN_USERNAME',
  //   credential: 'YOUR_TURN_CREDENTIAL'
  // }
];

// Capture/encoding presets. Bitrates are max targets; WebRTC can still
// reduce bitrate when network conditions require it.
const STREAM_PRESETS = {
  performance: { label: 'Performance · 720p / 30 FPS', width: 1280, height: 720, frameRate: 30, maxBitrate: 2_500_000 },
  balanced: { label: 'Balanced · 1080p / 30 FPS', width: 1920, height: 1080, frameRate: 30, maxBitrate: 4_500_000 },
  quality: { label: 'Quality · 1440p / 30 FPS', width: 2560, height: 1440, frameRate: 30, maxBitrate: 8_000_000 },
  smooth: { label: 'Smooth · 1080p / 60 FPS', width: 1920, height: 1080, frameRate: 60, maxBitrate: 6_500_000 }
};

module.exports = {
  SUPABASE_URL: 'https://ypeepmdjqprrkwilbsfl.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlwZWVwbWRqcXBycmt3aWxic2ZsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTAzNjQ2OTMsImV4cCI6MjEwNTk0MDY5M30.e2UkatnnBjzhglhI_jA_LP6UAA9iEScM40bF3gpPj0g',
  LOOPBACK_PORT: 53682,
  ICE_SERVERS,
  STREAM_PRESETS
};
