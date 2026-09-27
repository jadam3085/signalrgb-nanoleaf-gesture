# Nanoleaf Gesture for SignalRGB

A SignalRGB network add-on that drives Nanoleaf panels (Shapes, Canvas, Elements,
Light Panels, Lines) from the SignalRGB canvas. It can also blend in colours from a
local HTTP "gesture feed", so another program can paint the panels for a moment
(for example a hand-gesture tracker) while SignalRGB stays the only thing sending
to them.

**Install:** [signalrgb://addon/install?url=https://github.com/jadam3085/signalrgb-nanoleaf-gesture](signalrgb://addon/install?url=https://github.com/jadam3085/signalrgb-nanoleaf-gesture)

GitHub does not open `signalrgb://` links from a README. Copy the link into your
browser's address bar, or add the URL under SignalRGB → Settings → Add-ons.

> Run this add-on **instead of** SignalRGB's built-in Nanoleaf add-on, not alongside
> it. Both would stream to the same controller and the panels would flicker. Disable
> the built-in one first.

## What it does

- **Discovery.** It finds controllers over mDNS (`_nanoleafapi._tcp`). You can also
  type an IP address on the add-on page.
- **Pairing.** Hold the controller's power button for 5–7 seconds until the lights
  flash, then press **Link** within 30 seconds. The add-on calls `POST /api/v1/new`
  and stores the token in SignalRGB's service settings (`<controller id>` / `key`).
  Known controllers are cached under `ipCache` / `cache`.
- **Canvas mapping.** It reads `panelLayout` and skips controllers, connectors,
  caps and the Rhythm module. Each light panel becomes one LED, placed at its raw
  `x`/`y` position rotated by `180 - globalOrientation` (positionData is y-down,
  screen-style, as the Nanoleaf app draws it; applying the literal `globalOrientation`
  after negating y to y-up gets one axis right and the other mirrored -- see
  `../README.md` "Orientation fix" for the full derivation), so SignalRGB samples the
  canvas where each panel physically sits, the same way round as the gesture engine's
  own `nanoleaf_fx.Layout` (kept in lockstep on purpose: a right-hand gesture blob and
  a Screen Ambience sweep need to agree on which side of the wall is which).
- **Streaming.** It switches the controller to extControl v2 once
  (`PUT /effects {"write":{"command":"display","animType":"extControl","extControlVersion":"v2"}}`).
  After that, every SignalRGB frame is sent as one UDP packet to port 60222.

### Settings (per device)

| Setting | Default | Meaning |
|---|---|---|
| Gesture overlay (`gestureFeed`) | on | Poll the gesture feed and blend its frames in |
| Gesture feed URL (`gestureUrl`) | `http://127.0.0.1:8936/nanoleaf/frame` | Feed endpoint |
| Smooth transitions | off | Transition time 1 (100 ms) instead of 0 in each frame |
| Turn panels off on shutdown | off | `PUT /state {"on":{"value":false}}` when streaming stops |

## The gesture feed

While the overlay is enabled, the add-on polls `gestureUrl` with `GET`. It never has
more than one request in flight, and it aborts a request after 400 ms. The poll rate
depends on the last result:

| Condition | Poll rate |
|---|---|
| Last response had `active: true` | 30 Hz |
| Idle | 4 Hz |
| 3 or more consecutive failures | 1 Hz |

Response body:

```json
{"active": true, "seq": 42, "mix": 0.8, "ttl_ms": 500,
 "panels": [[9223, 0, 90, 255], [27871, 255, 0, 0]]}
```

- The overlay applies only while the frame is `active` and fresh. A frame is fresh
  until `ttl_ms` has passed since it arrived (default 500 ms, capped at 5 s). For
  each listed panel id the output is
  `lerp(signalrgb_colour, frame_colour, mix)`, with `mix` clamped to 0..1
  (default 1). Panels not listed keep the SignalRGB colour.
- Any other case gives pure SignalRGB colours. That covers inactive, stale,
  missing, non-200, unparsable and malformed responses, and a disabled overlay.
- Only the render loop sends UDP. The feed never talks to the panels directly.

## extControl v2 frame format

Nanoleaf OpenAPI, "External Control (extControl) Streaming", version v2. All
multi-byte fields are big-endian.

```
nPanels            uint16
repeat nPanels times:
  panelId          uint16
  R, G, B, W       uint8 each   (W is sent as 0)
  transitionTime   uint16       (units of 100 ms)
```

## Files

- `NanoleafGesture.js`: the add-on (discovery service, device lifecycle, gesture feed)
- `NanoleafGesture.qml`: the add-on page (controller list, Link / Unlink / Forget, add by IP)

## References

This is a clean-room implementation. It contains no code from SignalRGB's built-in
Nanoleaf add-on, which carries no license, or from any other unlicensed add-on.
It was written only from these sources:

- **Nanoleaf OpenAPI documentation** (public): the local API on port 16021, the
  auth token flow (`POST /api/v1/new`), `GET /api/v1/<token>/`, `panelLayout` /
  `layout.positionData` / `globalOrientation` and the `shapeType` values, the
  `effects` write for `extControl` v2, the v2 UDP frame format on port 60222, and
  `state/on`, and the `_nanoleafapi._tcp` mDNS service type. The TXT `id` / `md` /
  `srcvers` keys used for controller identity come from what the controller itself
  advertises.
  <https://forum.nanoleaf.me/docs>
- **SignalRGB developer documentation** (public): the plugin runtime
  (Initialize / Render / Shutdown, `on<Property>Changed` callbacks), user controls
  (`ControllableParameters` boolean / textfield), plugin exports, device utilities
  (`device.color`, `device.log`) and network communication (UDP).
  - <https://docs.signalrgb.com/developer/plugins/>
  - <https://signalrgb.developerhub.io/plugins/runtime.md>
  - <https://signalrgb.developerhub.io/plugins/user-controls.md>
  - <https://signalrgb.developerhub.io/plugins/plugin-exports.md>
  - <https://signalrgb.developerhub.io/plugins/optional-export-flags.md>
  - <https://signalrgb.developerhub.io/plugins/utilities.md>
  - <https://docs.signalrgb.com/developer/plugins/advanced-communication/>
- **MIT-licensed community add-ons.** Both were checked for an MIT `LICENSE` file,
  and both are original repositories, not forks. They were consulted only for the
  shape of SignalRGB's network-service API, which the public docs do not cover:
  `DiscoveryService` with `MDns`, `connect(devices)` and `forceDiscover`;
  `service.addController`, `getController`, `updateController`,
  `announceController`, `getSetting` and `saveSetting`; the `controller` global;
  `udp.send(ip, port, data)`; `XMLHttpRequest`; and the QML `service.controllers`
  list.
  - BigChiefRick/SignalRGB-LIFX (MIT): <https://github.com/BigChiefRick/SignalRGB-LIFX>
  - wrzonance/DMXr (MIT): <https://github.com/wrzonance/DMXr>
- **Setting names.** The service settings layout (`<id>`/`key`, `ipCache`/`cache`)
  was taken from the author's own SignalRGB registry entries. That keeps an existing
  pairing working when you switch add-ons.

## License

MIT. See [LICENSE](LICENSE).
