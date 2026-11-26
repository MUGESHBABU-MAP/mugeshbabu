# Certificates gallery

The Certificates section reads `images/certificates/certificates.json`. That file is generated from the images in the same folder. Do not edit it by hand.

## Add or remove a certificate

1. Put a `.jpg`, `.jpeg`, `.png` or `.webp` file in `images/certificates/`, or delete one.
2. Commit and push to `main`.
3. The **Update certificate manifest** workflow regenerates the manifest, commits it as `github-actions[bot]`, and requests a GitHub Pages build. The change is live a minute or two later.

To preview before pushing, run `node scripts/generate-certificates.mjs` and open the site locally. You may commit the regenerated manifest with your images; the workflow only commits when the file differs.

## Commands

| Command | What it does |
| --- | --- |
| `node scripts/generate-certificates.mjs` | Scan the folder and write the manifest |
| `node scripts/generate-certificates.mjs --check` | Exit 1 if the manifest is out of date |
| `node --test scripts/certificates.test.mjs` | Run the generator tests |

## Titles and metadata

- A readable file name is only reformatted: `claude_associate.jpg` becomes "Claude Associate".
- A generic name such as `map01`, `image001` or `IMG_2024...` becomes a neutral "Certificate 01".
- Duplicate titles get " (2)", " (3)" and so on, whatever their source.
- To set real titles, create `images/certificates/certificates.meta.json`. Every entry and every field is optional:

```json
{
  "map01.jpeg": { "title": "Course name", "issuer": "Issuer", "date": "Nov 2020" }
}
```

  - `title` and `issuer` must be text. `date` may be text or a number such as `2024`.
  - Missing, blank or wrongly typed values are ignored and the generated title is used. Nothing blank is ever shown.
  - Keys match the file name exactly, or ignoring letter case and the way accents are encoded.
  - Entries for files that do not exist are ignored. Values are shown as plain text, never as HTML.

## What is ignored

Hidden files, folders, symlinks, unsupported extensions, temporary files (`~`, `.tmp`, `.crdownload`, ...) and the two JSON files. Truncated or corrupt images are left out and listed under `skipped` in the manifest. Images over 1.5 MB are included but print a warning.

## How deployment works

GitHub Pages serves the `main` branch as-is, with no build step, so the manifest has to be a committed file. The workflow in `.github/workflows/certificates-manifest.yml` keeps it current.

- **Runs when** a push to `main` changes `images/certificates/**` (except the manifest itself) or the generator. It can also be started by hand from the Actions tab.
- **Does** run the generator tests, regenerate the manifest, commit it if it changed, and ask Pages for a rebuild.
- **Cannot loop.** The bot's commit only touches the manifest, which the trigger excludes. Pushes made with the built-in token also never start new runs, and nothing is committed when the manifest is unchanged.
- **Permissions** are `contents: write` and `pages: write`, set in the workflow. The repository's default workflow permission is already `write`, and `main` has no branch protection. If you later protect `main`, allow `github-actions[bot]` to push to it.
- Pages must stay on **Deploy from a branch: `main` / root**.

## First-run verification

After the first merge to `main`:

1. Open **Actions**. If a run named *Update certificate manifest* appears, it should finish green. It may also be skipped, because the merge already contains an up-to-date manifest.
2. Add a test image, for example copy any certificate to `images/certificates/test-run.jpg`, and push to `main`.
3. In **Actions**, open the new run. Expect these steps to pass: *Test the generator*, *Generate the manifest*, *Commit the manifest if it changed* (logs show a commit), *Request a Pages build*.
4. In **Commits**, expect one new commit by `github-actions[bot]` titled `chore: update certificate manifest` that changes only `certificates.json`. There must be no second workflow run after it.
5. In **Actions**, expect a *pages build and deployment* run for that commit.
6. After a minute or two, open the site's Certificates section. "Test Run" should appear.
7. Delete `test-run.jpg`, push, and confirm it disappears the same way.

If step 4 shows no bot commit, open the *Commit the manifest* step log. A `403` means the repository's Actions permissions were changed: check **Settings > Actions > General > Workflow permissions**. If step 5 is missing, open the *Request a Pages build* step; it prints a warning with the reason, and you can start a build from **Settings > Pages**.
