const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs-extra');
const path = require('path');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

const app = express();
const PORT = process.env.PORT || 3000;

// Use PAT token for repo creation
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_USERNAME = process.env.GITHUB_USERNAME || 'LustyStorage';
const BASE_REPO_NAME = 'jav-actress';

let globalSummary = {
    startTime: null,
    endTime: null,
    totalPages: 0,
    processedPages: 0,
    totalMoviesFound: 0,
    totalSuccessfulDownloads: 0,
    totalFailedDownloads: 0,
    pages: []
};

let globalErrorLog = [];

// Test FlareSolverr
async function testFlareSolverr() {
    try {
        const response = await axios.post('http://localhost:8191/v1', {
            cmd: 'request.get',
            url: 'https://httpbin.org/anything',
            maxTimeout: 10000
        }, {
            timeout: 10000,
            headers: { 'Content-Type': 'application/json' }
        });
        
        if (response.data && response.data.status === 'ok') {
            console.log('✅ FlareSolverr is working');
            return true;
        }
        return false;
    } catch (error) {
        console.log('⚠️ FlareSolverr not available');
        return false;
    }
}

// Fetch with FlareSolverr
async function fetchWithFlareSolverr(url) {
    const response = await axios.post('http://localhost:8191/v1', {
        cmd: 'request.get',
        url: url,
        maxTimeout: 60000,
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    }, {
        headers: { 'Content-Type': 'application/json' }
    });
    
    if (response.data && response.data.status === 'ok') {
        return response.data.solution.response;
    }
    throw new Error('FlareSolverr failed');
}

// Create repository using PAT
async function createGitHubRepository(repoName) {
    if (!GITHUB_TOKEN) {
        throw new Error('No GITHUB_TOKEN found');
    }

    console.log(`  Creating repository: ${repoName}...`);
    
    // Check if repo exists
    try {
        const checkResponse = await axios.get(`https://api.github.com/repos/${GITHUB_USERNAME}/${repoName}`, {
            headers: {
                'Authorization': `token ${GITHUB_TOKEN}`,
                'Accept': 'application/vnd.github.v3+json'
            }
        });
        console.log(`  Repository ${repoName} already exists`);
        return checkResponse.data.clone_url;
    } catch (checkError) {
        if (checkError.response?.status !== 404) {
            console.log(`  Check error: ${checkError.response?.status}`);
        }
    }
    
    // Create new repository
    const response = await axios.post('https://api.github.com/user/repos', {
        name: repoName,
        description: `JAV actress data for sitemap page ${repoName.split('-').pop()}`,
        private: false,
        auto_init: true
    }, {
        headers: {
            'Authorization': `token ${GITHUB_TOKEN}`,
            'Accept': 'application/vnd.github.v3+json',
            'Content-Type': 'application/json'
        }
    });
    
    console.log(`  ✅ Created repository: ${repoName}`);
    return response.data.clone_url;
}

// Push to GitHub
async function pushToGitHub(page, dataDir, repoUrl) {
    const cloneDir = path.join(__dirname, 'temp_repos', `page-${page}`);
    
    try {
        await fs.remove(cloneDir);
        
        const repoUrlWithToken = repoUrl.replace('https://', `https://${GITHUB_USERNAME}:${GITHUB_TOKEN}@`);
        await execPromise(`git clone ${repoUrlWithToken} ${cloneDir}`);
        
        // Copy data
        await fs.copy(dataDir, path.join(cloneDir, 'data'));
        
        // Create summary
        const files = await fs.readdir(path.join(cloneDir, 'data'));
        const htmlFiles = files.filter(f => f.endsWith('.html'));
        
        const summary = {
            page: page,
            total_movies: htmlFiles.length,
            timestamp: new Date().toISOString(),
            repo_name: `jav-actress-${page}`
        };
        await fs.writeJson(path.join(cloneDir, 'SUMMARY.json'), summary, { spaces: 2 });
        
        // Commit and push
        await execPromise(`git config user.name "github-actions"`, { cwd: cloneDir });
        await execPromise(`git config user.email "actions@github.com"`, { cwd: cloneDir });
        await execPromise(`git add .`, { cwd: cloneDir });
        await execPromise(`git commit -m "Add data for page ${page}"`, { cwd: cloneDir });
        await execPromise(`git push origin main`, { cwd: cloneDir });
        
        await fs.remove(cloneDir);
        return true;
    } catch (error) {
        console.error(`  Push failed: ${error.message}`);
        return false;
    }
}

// Process single page
async function processSinglePage(page) {
    console.log(`\n📄 STARTING PAGE ${page}`);
    
    // Step 1: Create repository
    const repoName = `${BASE_REPO_NAME}-${page}`;
    const repoUrl = await createGitHubRepository(repoName);
    
    // Step 2: Find and parse sitemap
    console.log(`  Fetching sitemap for page ${page}...`);
    const sitemapUrl = `https://missav.ws/sitemap_actresses_${page}.xml`;
    
    let movieIds = [];
    try {
        const sitemapContent = await fetchWithFlareSolverr(sitemapUrl);
        const $ = cheerio.load(sitemapContent, { xmlMode: true });
        
        $('url').each((i, el) => {
            const loc = $(el).find('loc').text().trim();
            if (loc) {
                const slug = loc.split('/').pop();
                if (slug && !slug.includes('.xml')) {
                    movieIds.push(slug);
                }
            }
        });
        
        console.log(`  Found ${movieIds.length} movie IDs`);
    } catch (error) {
        console.error(`  Failed to fetch sitemap: ${error.message}`);
        return { total: 0, successful: 0 };
    }
    
    if (movieIds.length === 0) {
        console.log(`  No movies found for page ${page}`);
        return { total: 0, successful: 0 };
    }
    
    // Step 3: Download movies
    console.log(`  Downloading ${movieIds.length} movies...`);
    const dataDir = path.join(__dirname, 'temp', `page-${page}`, 'data');
    await fs.ensureDir(dataDir);
    
    let successCount = 0;
    
    for (let i = 0; i < Math.min(movieIds.length, 10); i++) { // Limit to 10 for testing
        const movieId = movieIds[i];
        const movieUrl = `https://missav.ws/en/actresses/${movieId}`;
        
        try {
            console.log(`    [${i+1}/${Math.min(movieIds.length, 10)}] Downloading ${movieId}...`);
            const html = await fetchWithFlareSolverr(movieUrl);
            await fs.writeFile(path.join(dataDir, `${movieId}.html`), html);
            successCount++;
            await new Promise(resolve => setTimeout(resolve, 1000));
        } catch (error) {
            console.error(`    Failed: ${error.message}`);
        }
    }
    
    // Step 4: Push to GitHub
    console.log(`  Pushing to GitHub...`);
    await pushToGitHub(page, dataDir, repoUrl);
    
    // Step 5: Cleanup
    await fs.remove(path.join(__dirname, 'temp', `page-${page}`));
    
    console.log(`✅ Page ${page} complete: ${successCount}/${Math.min(movieIds.length, 10)} movies`);
    
    return { total: movieIds.length, successful: successCount };
}

// Main function
async function main() {
    console.log('🚀 Starting scraper...');
    
    const startPage = parseInt(process.env.START_PAGE) || 1;
    const endPage = parseInt(process.env.END_PAGE) || 5;
    
    globalSummary.startTime = new Date().toISOString();
    globalSummary.totalPages = endPage - startPage + 1;
    
    for (let page = startPage; page <= endPage; page++) {
        console.log(`\n${'='.repeat(50)}`);
        console.log(`Processing page ${page}/${endPage}`);
        console.log(`${'='.repeat(50)}`);
        
        try {
            const result = await processSinglePage(page);
            globalSummary.processedPages++;
            globalSummary.totalMoviesFound += result.total;
            globalSummary.totalSuccessfulDownloads += result.successful;
            globalSummary.totalFailedDownloads += result.total - result.successful;
            
            globalSummary.pages.push({
                page: page,
                total_movies: result.total,
                successful: result.successful,
                failed: result.total - result.successful,
                repository: `https://github.com/${GITHUB_USERNAME}/jav-actress-${page}`
            });
            
        } catch (error) {
            console.error(`Failed to process page ${page}:`, error.message);
        }
        
        if (page < endPage) {
            console.log(`\nWaiting 5 seconds...`);
            await new Promise(resolve => setTimeout(resolve, 5000));
        }
    }
    
    globalSummary.endTime = new Date().toISOString();
    globalSummary.duration_seconds = (new Date(globalSummary.endTime) - new Date(globalSummary.startTime)) / 1000;
    
    await fs.writeJson('./summary.json', globalSummary, { spaces: 2 });
    await fs.writeJson('./error_log.json', { errors: globalErrorLog }, { spaces: 2 });
    
    console.log('\n🎉 ALL DONE!');
    console.log(`Pages: ${globalSummary.processedPages}/${globalSummary.totalPages}`);
    console.log(`Movies: ${globalSummary.totalSuccessfulDownloads}/${globalSummary.totalMoviesFound}`);
}

// Start
app.listen(PORT, async () => {
    console.log(`Server on port ${PORT}`);
    
    const flaresolverrOk = await testFlareSolverr();
    if (!flaresolverrOk) {
        console.error('❌ FlareSolverr is required!');
        process.exit(1);
    }
    
    if (!GITHUB_TOKEN) {
        console.error('❌ GITHUB_TOKEN (PAT) is required!');
        process.exit(1);
    }
    
    await main();
    setTimeout(() => process.exit(0), 3000);
});
