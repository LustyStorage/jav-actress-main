## Setup Instructions

1. **Add GitHub Token Permissions**: The `GITHUB_TOKEN` automatically has permission to create repositories, but you need to ensure it has the right scopes. In your repository settings, under Actions → General → Workflow permissions, select "Read and write permissions".

2. **Environment Variables**: The code uses `process.env.GITHUB_USERNAME` which will be automatically set by GitHub Actions to the repository owner.

3. **How it works**:
   - For each page (1, 2, 3...), it creates a new repository named `jav-actress-1`, `jav-actress-2`, etc.
   - If the repository already exists, it uses the existing one
   - Each movie downloaded is committed and pushed immediately to its page-specific repository
   - After all pages are processed, a summary issue is created

4. **Repository Structure**: Each `jav-actress-{page}` repository will contain:
   - `sitemap.xml` - The original sitemap data
   - `movie_ids.json` - List of all movie IDs for that page
   - `data/` folder with all HTML files and JSON metadata
   - `SUMMARY.json` - Processing summary for that page

5. **Customization**: You can adjust:
   - Start/end pages via workflow inputs
   - Repository name prefix by changing `BASE_REPO_NAME`
   - Delay between pushes by modifying the `sleep(500)` value

This approach will create separate repositories for each sitemap page and push data to them sequentially!
