# Pervent Client — GitHub Actions Windows Build

This project now includes a GitHub Actions workflow at:

`.github/workflows/build-windows.yml`

## Build it on GitHub

1. Create a new GitHub repository.
2. Upload the **contents of `ZenithSourceCode`** to the repository (do not upload the outer folder as an extra layer if you can avoid it).
3. Commit and push the files.
4. On GitHub, open **Actions**.
5. Select **Build Pervent Client**.
6. Click **Run workflow**.
7. Wait for the Windows job to finish.
8. Open the completed workflow run and download the **Pervent-Client-Windows** artifact.

The workflow uses a Windows GitHub-hosted runner and Node.js 20 LTS, so the local Visual Studio/node-gyp problem does not need to be fixed on your PC just to create the installer.

## Important

The current application is configured to contact the license API at `http://127.0.0.1:38473` according to `electron/license-config.json`. The Electron installer build does **not** automatically host that API or the Discord bot. Those services need to be run separately wherever you intend to host them.

The existing `package.json` intentionally excludes `license-data`, `discord-bot`, and `.env` from the packaged Electron application.
