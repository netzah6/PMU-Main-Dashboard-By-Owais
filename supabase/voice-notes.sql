-- 🎤 Voice notes from the AI tab chat (2026-10-07). The dashboard records an
-- MP3, stores it here under an unguessable name, and GoHighLevel sends it as
-- a text with the audio attached (GHL needs a public URL to fetch it from).
-- Public READ by exact path only — no policy lets anyone list the bucket.
-- Writes happen server-side with the service role (/api/ghl/reply/voice).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('voice-notes', 'voice-notes', true, 1048576, array['audio/mpeg'])
on conflict (id) do update set public = excluded.public, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;
