<!-- Thank you. CONTRIBUTING.md has the rules; this is the short version. -->

## What and why

<!-- What changes for the people who use or run Kept, and why. Link the issue or discussion. -->

## Checks

- [ ] `bash scripts/ci-local.sh` passes (or `--fast`, and say which steps you couldn't run)
- [ ] Tests first, on their own database; the leak test and route catalogue updated for a new table or route
- [ ] Migrations are additive (a drop or rename takes two releases)
- [ ] New strings in all five catalogues, Arabic in the house style; logical CSS; works at 375 px and 1280
- [ ] Conventional commit messages; no AI attribution in commits or this description (D173)
- [ ] Every commit signed off (`git commit -s`, the DCO in CONTRIBUTING.md)
