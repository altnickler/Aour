-- New public verification states for happy-hour information (see src/core/ingest/confidence.ts).
-- Kept in their own migration: a new enum value can't be used in the transaction that adds it.
--   verified                 confirmed by an Aour admin with a recorded source
--   establishment_reported   published by the venue itself (official website / owner)
--   community_reported       users or open data, not independently confirmed
--   unverified               "Needs verification"
--   outdated                 stale or reported changed
--   none                     no happy-hour information available
alter type public.hh_status add value if not exists 'establishment_reported';
alter type public.hh_status add value if not exists 'community_reported';

alter type public.source_kind add value if not exists 'official_website';
alter type public.source_kind add value if not exists 'open_data';
