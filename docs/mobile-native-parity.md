# Mobile native parity and performance

The Android app is a React Native client of the EdgeEver API. The PWA remains the product reference for features and visual language, but it must not be embedded as the primary App workspace.

## Performance acceptance targets

These targets are measured on a mid-range Android device using a signed release build and an already authenticated account.

| Path | Target |
| --- | --- |
| Cold launch to native shell | under 1.0 s |
| Warm launch to cached notebook and memo list | under 0.5 s |
| Cached list to usable state | no network dependency |
| Memo list scrolling | no sustained dropped-frame sequence |
| Search typing | no request per keystroke; 250 ms debounce |
| Filter or sort change | keep prior content until replacement data is ready |

Build success is not a performance result. Before a Play production rollout, record cold and warm launch timings on a physical device and compare them with the currently published internal build.

## Architecture rules

- Render startup, navigation, notebook selection, memo lists, search, settings, and the Markdown editor with native React Native views.
- Reuse the shared API client and shared data types instead of duplicating backend contracts.
- Hydrate only the default notebook and memo-list queries at startup. Refresh stale data in the background.
- Clear persisted query data when the account changes, signs out, or becomes unauthorized.
- Keep optional heavyweight features out of the startup path. A WebView may only be used for an explicitly selected compatibility editor, never as the App workspace.
- Use virtualized lists and stable item components for collections.

## Feature parity status

| PWA capability | Native status |
| --- | --- |
| Login and self-hosted instance connection | Implemented |
| Notebook hierarchy and management | Implemented |
| Memo list, filters, sort, pin, trash, batch operations | Implemented |
| Search | Implemented |
| Native Markdown create/edit flow | Implemented |
| Attachments, image compression, resource library | Implemented |
| Tags and templates | Implemented |
| Revision history and restore | Implemented |
| Offline draft and sync queue | Implemented |
| MCP/API token management | Implemented |
| Password change | Pending native UI |
| Multi-user management | Pending native UI |
| Unified EdgeEver ZIP import/export | Pending native UI and filesystem bridge |

Pending parity items must be implemented natively or through a native system bridge. They must not be solved by restoring the PWA workspace WebView.
