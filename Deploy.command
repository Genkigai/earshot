#!/bin/bash
# Double-click to deploy Sight and Sound to GitHub Pages.
cd "$(dirname "$0")" || exit 1
echo "→ Syncing latest code from the dev folder…"
rsync -a --delete \
  --exclude 'config.js' --exclude '.git' --exclude 'Deploy.command' \
  --exclude '.claude' --exclude '.DS_Store' --exclude 'earshot-SECRETS.txt' --exclude '*.log' \
  /Users/lelandstout/Coding/earshot/ ./
git add -A
git diff --cached --quiet || git commit -m "Deploy $(date '+%Y-%m-%d %H:%M')"
echo "→ Pushing to GitHub…"
if git push origin main; then
  echo ""; echo "✅ Deployed! Wait ~1 minute, then fully close & reopen the app on your phone."
else
  echo ""; echo "❌ Push failed — first time: it will ask for your GitHub username + token (see chat)."
fi
echo ""; read -n 1 -s -r -p "Press any key to close."
