# Lumexia fixtures

Written by hand from the as-built contract in `docs/lumexia-api.md`: there are no recorded responses yet. The opt-in
live test in `../http.test.ts` (`LUMEXIA_LIVE=1`) checks these shapes against a dev Lumexia; when Lumexia changes the
API, update `docs/lumexia-api.md` first, then these files.

`lots.json` holds the same lot number on two items on purpose (`GET /lots?lot_number=` returns a list for that reason).
