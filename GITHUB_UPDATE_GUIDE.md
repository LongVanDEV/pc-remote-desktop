# GitHub Releases Auto-Update Guide

This project uses `electron-updater` with electron-builder's native GitHub provider.
The installed Windows NSIS build reads the GitHub repository from the packaged
`app-update.yml`; do not use `UPDATE_SERVER_URL`.

## 1. Create the GitHub repository

Create a repository such as:

    https://github.com/YOUR_GITHUB_USERNAME/pc-remote-desktop

A public repository is the simplest setup because normal users can check public
releases without shipping a GitHub token inside the app.

## 2. Set the repository name in `package.json`

Open `package.json` and replace:

    YOUR_GITHUB_USERNAME

in BOTH places:

    "repository": {
      "url": "https://github.com/YOUR_GITHUB_USERNAME/pc-remote-desktop.git"
    }

and:

    "build": {
      "publish": {
        "provider": "github",
        "owner": "YOUR_GITHUB_USERNAME",
        "repo": "pc-remote-desktop"
      }
    }

Keep `repo` exactly equal to the GitHub repository name.

## 3. Put your Supabase values in `src/renderer/config.js`

Set your real:

    SUPABASE_URL
    SUPABASE_ANON_KEY

Do NOT put a GitHub token in this file.

## 4. Install dependencies

PowerShell:

    npm install

## 5. Build the first version

If `package.json` says version `0.2.0`:

    npm run dist

Install the generated:

    dist\\PC Remote Desktop Setup 0.2.0.exe

Use the NSIS installer, not the portable EXE, for auto-update testing.

## 6. Create a GitHub publishing token

Create a GitHub fine-grained personal access token for the repository.
Give it repository `Contents` write permission. Keep the token private.

Do NOT commit the token to Git, `package.json`, `config.js`, or this project.

## 7. Publish version 0.2.0 to GitHub

In PowerShell, from the project folder:

    $env:GH_TOKEN="YOUR_GITHUB_TOKEN"
    npm run release

The release script runs:

    electron-builder --win --publish always

electron-builder uploads the Windows release artifacts and update metadata to
the configured GitHub repository.

## 8. Make an update

Change the version in `package.json`, for example:

    "version": "0.2.1"

Make your code changes, then run:

    npm install
    $env:GH_TOKEN="YOUR_GITHUB_TOKEN"
    npm run release

A new GitHub release is created for the new version.

## 9. How clients update

A packaged 0.2.0 NSIS installation will periodically check the GitHub release
feed. When 0.2.1 is published, `electron-updater` downloads it. The app is set
to install the downloaded update when the application quits/restarts.

The tray menu also has **Check for updates** for a manual check.

## 10. Recommended release sequence

Every update should follow this pattern:

    1. Change package.json version: 0.2.0 -> 0.2.1
    2. Test the app locally
    3. Set GH_TOKEN in the PowerShell session
    4. Run npm run release
    5. Verify the GitHub release contains the installer and latest.yml
    6. Install the release on a test PC
    7. Publish the next version only after the previous update works

## 11. Important rules

- Never reuse an old version number for a different build.
- Never put `GH_TOKEN` in source code.
- Keep the GitHub `owner` and `repo` values correct and stable.
- Use NSIS installs for auto-update; the portable build is not the managed
  auto-update target.
- If you transfer or rename the GitHub repository, update the application's
  publish configuration and test a fresh install/update path.

## 12. Useful commands

Build without publishing:

    npm run dist

Build and publish to GitHub:

    $env:GH_TOKEN="YOUR_GITHUB_TOKEN"
    npm run release

Check Git history:

    git status
    git add .
    git commit -m "Prepare release 0.2.1"
    git push

`git push` updates your source repository. `npm run release` is the command that
builds and publishes the Windows release artifacts used by the auto-updater.
