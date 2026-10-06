# Interactive Visual Lab

Small, independent creative coding experiments. The first experiment uses the supplied animated GIF itself as the visual building block for a pair of swimmer formations.

## Preview locally

Serve the `public` directory with a static HTTP server and open its root URL. The project uses native HTML, CSS, JavaScript and canvas; it has no package dependencies or build step.

On a secure origin (HTTPS, or localhost), the experiment asks for camera permission and reacts to motion detected in the webcam image. Camera frames are processed locally in the browser and are not uploaded. Mouse and touch input remain available if camera access is unavailable or declined.

## Publishing on Vercel

The root `vercel.json` selects Vercel's `Other` preset, skips the build step, and serves `public/` as the output directory. Import the repository with its root set to this directory. Deployments can then follow updates pushed to the main branch. Keep each released experiment under `public/experiments/<slug>/` with its assets, and preserve working revisions in Git history or release tags.
