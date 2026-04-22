# Zen3

Browser-based satisfying loop generator and scene editor.

## What it is

This project is a static web app. There is no backend server. The simulation,
audio synthesis, editor UI, and MP4 export all run in the user's browser.

## Local preview

Use any static file server from the project root:

```powershell
python -m http.server 8080
```

Then open `http://localhost:8080`.

## GitHub Pages

This project can be hosted directly on GitHub Pages because it is a static
site (`index.html`, `styles.css`, `src/*.js`).

Notes:

- The app itself works on GitHub Pages.
- The optional `export_video.py` helper does not run on GitHub Pages.
- MP4 export depends on browser support for WebCodecs and works best in
  Chrome or Edge.

## Publish steps

1. Create a GitHub repository.
2. Push this folder to the `main` branch.
3. In GitHub, open `Settings -> Pages`.
4. Set the source to `Deploy from a branch`.
5. Select branch `main` and folder `/ (root)`.
6. Save and wait for the Pages URL to appear.
