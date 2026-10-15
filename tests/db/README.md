# Database tests

These tests apply the **real** migrations in `supabase/migrations/` to a throwaway PostgreSQL database. They then exercise row-level security exactly as Supabase's API does: `set role anon/authenticated` plus the JWT `sub` claim.

`supabase-shim.sql` provides the few pieces of Supabase the migrations depend on: `auth.users`, `auth.uid()`, `storage.objects`, `storage.foldername()`, and the `anon`/`authenticated` roles with Supabase's broad default grants. The grants are there on purpose, to prove our explicit revokes and grants are what actually protect the data.

Run locally with any Postgres 15+ superuser connection:

```bash
DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres npm run test:db
```

Each test file creates and drops its own database (`aour_test_*`). CI runs these against `postgres:17`.
