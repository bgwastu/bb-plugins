# Upstream source

- Repository: https://github.com/yusuf8834/bb-sidebar
- Branch: `main`
- Snapshot commit: `4fffb493072fc97b73c5ece339afb7c2512affa2`
- License: MIT; see `LICENSE`.

The upstream README credits code adapted from `SawyerHood/bb-plugin-t3sidebar` and the T3 Code sidebar design. Keep `LICENSE` and `THIRD_PARTY_NOTICES.md` with this package. This directory is a source snapshot; it does not automatically merge upstream changes.

## Local fork changes

- Added a dedicated action that opens BB's native composer with the personal project selected, creating a thread without a project.
- Made latest activity the default active-thread sort; Manual remains available.
- Deferred pull-request lookups until a thread row approaches the viewport, using one shared `IntersectionObserver` for the list.
