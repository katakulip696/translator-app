# Deploy Without Buying a Domain

You can publish this app with a free subdomain and use it on your phone.

## Recommended: Vercel (Free)

1. Push this folder to a GitHub repository.
2. Go to Vercel and click **Add New... -> Project**.
3. Import your repository.
4. Keep default build settings (no custom command needed for this project).
5. Add environment variable:
   - `GEMINI_API_KEY=YOUR_KEY`
6. Deploy.
7. Open the generated URL (for example `https://your-app.vercel.app`) on your phone.

## Local Test (optional)

1. Install dependencies:
   - `npm install`
2. Set environment variable:
   - PowerShell: `$env:GEMINI_API_KEY="YOUR_KEY"`
3. Start:
   - `npm start`
4. Open:
   - `http://localhost:3000`

## Notes

- No custom domain is required.
- Keep `GEMINI_API_KEY` only in platform environment variables, not in frontend code.
