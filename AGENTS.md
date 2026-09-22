# Repository Agent Instructions

## Compatibility and migrations

- The app has not yet been used in the field. Until that changes, backwards compatibility and database migrations are not routine requirements for changes in this repository.
- Before starting serious planning for a feature or other substantial change, ask Or whether backwards compatibility or a database migration is necessary for that work. Do not add either to the plan by default.
- Or will update this instruction when the app reaches the field.

## UX conventions

- Use toast notifications for all non-blocking success, warning, and failure feedback in the web UI. Do not use in-flow banners or duplicate operational feedback inside dialogs.
- Keep confirmation dialogs as explicit blocking decision points. Confirmation dialogs are not notifications and must not be replaced with toasts.
