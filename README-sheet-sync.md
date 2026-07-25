# Zainrsh Catalog — Easy Upload via Google Sheet

The Telegram bot is unreliable (Apps Script /exec 302-redirects every POST, which
Telegram refuses to follow). The dependable way to add products is a Google Sheet
that syncs straight to the store's products.json on GitHub.

## Sheet columns (row 1 = headers)
| A    | B        | C     | D     | E    | F      | G             | H       |
|------|----------|-------|-------|------|--------|---------------|---------|
| id   | category | name  | price | mrp  | image  | description   | inStock |

- **image** = paste an image URL (https://…) OR a repo path like images/foo.jpg.
  The site already displays absolute https URLs, so a pasted link works directly.
- **id** = leave blank to auto-generate (slug + timestamp).
- **inStock** = TRUE / FALSE (blank = TRUE).

## How to set it up (3 minutes, no coding)
1. Open your Google Sheet (or create one).
2. Extensions → Apps Script.
3. Replace the boilerplate with the contents of Code.gs (in this repo).
4. Save (Ctrl/Cmd+S). Reload the Sheet.
5. A "Zainrsh Catalog" menu appears → click **Sync → Site**.
   (It also auto-syncs ~15s after any edit.)

## Verify
After sync, wait ~1 min, then open the store — new products appear.
You can also trigger sync by opening the web-app URL with ?sync=1 in a browser
(browsers follow the /exec 302 fine; only Telegram doesn't).
