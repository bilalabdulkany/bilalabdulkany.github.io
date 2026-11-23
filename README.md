# Bilal Abdulkany — Portfolio v1

This is the first static prototype of the portfolio.

## Stack
- Plain HTML/CSS for the first version
- No database
- No backend
- GitHub as the source of truth
- Ready to move into Astro/MDX + Cloudflare Pages

## Before publishing
1. Replace `your-email@example.com`.
2. Add the real LinkedIn URL.
3. Replace the placeholder Account Ledger link.
4. Add real Ferrari/3D images or an embedded viewer.
5. Add individual project pages.
6. Move to Astro once the information architecture is approved.

## Design direction
Editorial engineering portfolio: restrained typography, dark technical sections, strong project storytelling, and a separate 3D Lab identity.

## Content note
Quantitative career claims should be tied to specific project pages or CV evidence before publication.


## Ferrari Enzo 3D viewer

The interactive viewer lives in `ferrari-enzo/`:
- `index.html` — Three.js viewer and UI
- `enzo-controls.js` — door, lamp and paint controls
- `ferrari_enzo_converted_v1_0_0.glb` — 3D model

The main portfolio embeds it in the 3D Lab section and also links to the standalone viewer.

### Deploy to the existing GitHub Pages repository

Copy the contents of this folder into the root of your existing
`bilalabdulkany.github.io` repository, preserving the `ferrari-enzo/` folder.
Commit and push. The embedded viewer uses relative paths, so it works under
the root GitHub Pages domain.


### Paint control fix

The GLB's primary body material is named `ENZO_MAT_RossoCorsa`, not `body`.
The rig now recognizes both `RossoCorsa` and generic `body` material names.
It updates the material colour without deleting any texture map.
