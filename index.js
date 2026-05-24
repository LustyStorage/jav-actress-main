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

// GitHub configuration
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_USERNAME = process.env.GITHUB_USERNAME || process.env.GITHUB_REPOSITORY_OWNER;
const BASE_REPO_NAME = 'jav-actress';

// Root directory
const ROOT_DIR = __dirname;

// FlareSolverr configuration
const FLARESOLVERR_URL = 'http://localhost:8191/v1';
let USE_FLARESOLVERR = true;

// Global tracking
let globalErrorLog = [];
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

// Function to create GitHub repository
async function createGitHubRepository(repoName, description = '') {
    if (!GITHUB_TOKEN) {
        console.log('⚠️  No GITHUB_TOKEN found, skipping repository creation');
        return false;
    }

    try {
        console.log(`  Creating repository: ${repoName}...`);
        const response = await axios.post('https://api.github.com/user/repos', {
            name: repoName,
            description: description,
            private: false,
            auto_init: true
        }, {
            headers: {
                'Authorization': `token ${GITHUB_TOKEN}`,
                'Accept': 'application/vnd.github.v3+json'
            }
        });
        
        console.log(`  ✅ Created repository: ${repoName}`);
        return response.data.clone_url;
    } catch (error) {
        if (error.response && error.response.status === 422) {
            console.log(`  📚 Repository ${repoName} already exists, using existing`);
            return `https://github.com/${GITHUB_USERNAME}/${repoName}.git`;
        }
        console.error(`  ❌ Failed to create repository: ${error.message}`);
        return false;
    }
}

// Function to initialize git repository for a page
async function initPageRepository(page, repoUrl) {
    const repoDir = path.join(__dirname, 'temp_repos', `page-${page}`);
    
    // Remove existing directory if it exists to ensure clean state
    if (await fs.pathExists(repoDir)) {
        console.log(`  Cleaning existing directory for page ${page}...`);
        await fs.remove(repoDir);
    }
    
    await fs.ensureDir(repoDir);
    
    try {
        console.log(`  Initializing git repository for page ${page}...`);
        
        // Initialize git
        await execPromise(`git init`, { cwd: repoDir });
        
        // Add remote
        await execPromise(`git remote add origin ${repoUrl}`, { cwd: repoDir });
        
        // Pull any existing content if repository already had data
        try {
            await execPromise(`git pull origin main --allow-unrelated-histories`, { cwd: repoDir });
            console.log(`  Pulled existing content from remote`);
        } catch (pullError) {
            console.log(`  No existing content to pull, starting fresh`);
        }
        
        // Create README if it doesn't exist
        const readmePath = path.join(repoDir, 'README.md');
        if (!await fs.pathExists(readmePath)) {
            await fs.writeFile(readmePath, `# ${repoUrl}\n\nJAV actress data for sitemap page ${page}\n\n## Structure\n- \`sitemap.xml\` - Original sitemap data\n- \`movie_ids.json\` - List of all movie IDs\n- \`data/\` - HTML files for each actress\n`, 'utf-8');
        }
        
        // Configure git user
        await execPromise(`git config user.name "github-actions"`, { cwd: repoDir });
        await execPromise(`git config user.email "actions@github.com"`, { cwd: repoDir });
        
        console.log(`  ✅ Git repository initialized for page ${page}`);
        return repoDir;
    } catch (error) {
        console.error(`  ❌ Failed to initialize git for page ${page}: ${error.message}`);
        return null;
    }
}

// Function to commit and push all changes for a page
async function commitAndPushAll(page, repoDir, finalPush = false) {
    if (!repoDir || !GITHUB_TOKEN) return false;
    
    try {
        // Check if there are changes to commit
        const { stdout } = await execPromise(`git status --porcelain`, { cwd: repoDir });
        
        if (stdout.trim()) {
            const commitMsg = finalPush ? 
                `Complete: Page ${page} with all data` : 
                `Update page ${page} data`;
            
            await execPromise(`git add .`, { cwd: repoDir });
            await execPromise(`git commit -m "${commitMsg}"`, { cwd: repoDir });
            await execPromise(`git push -u origin main`, { cwd: repoDir });
            
            console.log(`  📤 Pushed all changes for page ${page} to repository`);
            return true;
        } else {
            console.log(`  No changes to push for page ${page}`);
            return false;
        }
    } catch (error) {
        console.error(`  ❌ Failed to commit/push for page ${page}: ${error.message}`);
        return false;
    }
}

// Process a single sitemap page completely before moving to next
async function processSinglePageComplete(page) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`📄 STARTING PAGE ${page}`);
    console.log(`${'='.repeat(60)}`);
    
    const pageStartTime = Date.now();
    
    // Step 1: Create repository for this page
    console.log(`\n📍 Step 1: Creating/Getting repository for page ${page}...`);
    const repoName = `${BASE_REPO_NAME}-${page}`;
    const repoUrl = await createGitHubRepository(repoName, `JAV actress data for sitemap page ${page}`);
    
    if (!repoUrl) {
        console.log(`❌ Failed to create/get repository for page ${page}, skipping...`);
        return { totalMovies: 0, successful: 0, failed: 0, error: 'Repository creation failed' };
    }
    
    // Step 2: Initialize local git repository
    console.log(`\n📍 Step 2: Initializing local repository...`);
    const repoDir = await initPageRepository(page, repoUrl);
    if (!repoDir) {
        console.log(`❌ Failed to initialize git for page ${page}, skipping...`);
        return { totalMovies: 0, successful: 0, failed: 0, error: 'Git initialization failed' };
    }
    
    // Step 3: Fetch and parse sitemap
    console.log(`\n📍 Step 3: Fetching sitemap for page ${page}...`);
    const sitemapResult = await findWorkingSitemapUrl(page);
    
    let movieIds = [];
    
    if (sitemapResult && sitemapResult.data) {
        console.log(`  ✅ Found sitemap, parsing...`);
        const $ = cheerio.load(sitemapResult.data, { xmlMode: true });
        const uniqueIds = new Set();
        
        $('url').each((i, el) => {
            const $el = $(el);
            const loc = $el.find('loc').text().trim();
            if (loc) {
                const urlParts = loc.split('/');
                const slug = urlParts[urlParts.length - 1];
                if (slug && slug !== '' && !slug.includes('.xml') && !uniqueIds.has(slug)) {
                    uniqueIds.add(slug);
                    movieIds.push(slug);
                }
            }
        });
        
        console.log(`  📊 Found ${movieIds.length} unique movie IDs`);
        
        // Save sitemap data to repo
        const dataDir = path.join(repoDir, 'data');
        await fs.ensureDir(dataDir);
        await fs.writeFile(path.join(repoDir, 'sitemap.xml'), sitemapResult.data, 'utf-8');
        await fs.writeJson(path.join(repoDir, 'movie_ids.json'), { 
            page, 
            movieIds, 
            total: movieIds.length,
            fetched_at: new Date().toISOString()
        }, { spaces: 2 });
        
        // Push sitemap data immediately
        console.log(`  📤 Pushing sitemap data to repository...`);
        await commitAndPushAll(page, repoDir, false);
        
    } else {
        const errorMsg = `Could not find sitemap for page ${page}`;
        console.log(`  ❌ ${errorMsg}`);
        addErrorToLog('sitemap_not_found', page, null, errorMsg);
        return { totalMovies: 0, successful: 0, failed: 0, error: errorMsg };
    }
    
    if (movieIds.length === 0) {
        console.log(`  ⚠️ No movie IDs found for page ${page}, skipping...`);
        await commitAndPushAll(page, repoDir, true);
        return { totalMovies: 0, successful: 0, failed: 0 };
    }
    
    // Step 4: Download all movies for this page
    console.log(`\n📍 Step 4: Downloading ${movieIds.length} movies for page ${page}...`);
    let successCount = 0;
    let failCount = 0;
    const dataDir = path.join(repoDir, 'data');
    
    for (let i = 0; i < movieIds.length; i++) {
        const movieId = movieIds[i];
        const movieUrl = `https://missav.ws/en/actresses/${movieId}`;
        const htmlFilePath = path.join(dataDir, `${movieId}.html`);
        const metadataPath = path.join(dataDir, `${movieId}.json`);
        
        // Check if file already exists
        if (await fs.pathExists(htmlFilePath)) {
            const stats = await fs.stat(htmlFilePath);
            if (stats.size > 1000) {
                console.log(`  ⏭️  [${i + 1}/${movieIds.length}] ${movieId} - already downloaded`);
                successCount++;
                continue;
            }
        }
        
        try {
            // Try multiple URL patterns
            const urlsToTry = [
                `https://missav.ws/en/actresses/${movieId}`,
                `https://missav.com/en/actresses/${movieId}`,
                `https://missav.ai/en/actresses/${movieId}`
            ];
            
            let htmlContent = null;
            let successfulUrl = null;
            
            for (const tryUrl of urlsToTry) {
                try {
                    const response = await axios.get(tryUrl, {
                        headers: {
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
                        },
                        timeout: 15000
                    });
                    if (response.data && response.data.length > 1000) {
                        htmlContent = response.data;
                        successfulUrl = tryUrl;
                        break;
                    }
                } catch (e) {
                    // Try next URL
                }
            }
            
            if (!htmlContent) {
                throw new Error('Could not fetch from any URL');
            }
            
            // Save HTML file
            await fs.writeFile(htmlFilePath, htmlContent, 'utf-8');
            
            // Extract and save metadata
            const $ = cheerio.load(htmlContent);
            const title = $('title').text().trim() || movieId;
            const metadata = {
                id: movieId,
                title: title,
                url: successfulUrl,
                fetched_at: new Date().toISOString(),
                page: page,
                file_size_kb: (htmlContent.length / 1024).toFixed(1)
            };
            await fs.writeJson(metadataPath, metadata, { spaces: 2 });
            
            console.log(`  ✅ [${i + 1}/${movieIds.length}] ${movieId} (${metadata.file_size_kb} KB)`);
            successCount++;
            
            // Push after every 10 movies to avoid losing progress
            if ((i + 1) % 10 === 0 || i === movieIds.length - 1) {
                console.log(`  📤 Pushing progress (${i + 1}/${movieIds.length})...`);
                await commitAndPushAll(page, repoDir, false);
            }
            
            // Small delay to be respectful
            await sleep(500);
            
        } catch (error) {
            console.error(`  ❌ [${i + 1}/${movieIds.length}] ${movieId} - FAILED: ${error.message}`);
            failCount++;
            
            // Save error info
            addErrorToLog('movie_fetch', page, movieId, error.message, movieUrl);
            
            const errorFilePath = path.join(dataDir, `${movieId}.error.txt`);
            await fs.writeFile(errorFilePath, `Error: ${error.message}\nURL: ${movieUrl}\nTime: ${new Date().toISOString()}`, 'utf-8');
        }
    }
    
    // Step 5: Create final summary for this page
    console.log(`\n📍 Step 5: Creating final summary for page ${page}...`);
    const summary = {
        page: page,
        total_movies: movieIds.length,
        successful_downloads: successCount,
        failed_downloads: failCount,
        success_rate: `${((successCount / movieIds.length) * 100).toFixed(1)}%`,
        duration_seconds: ((Date.now() - pageStartTime) / 1000).toFixed(1),
        timestamp: new Date().toISOString(),
        repo_name: repoName,
        repo_url: repoUrl,
        movie_ids: movieIds
    };
    
    await fs.writeJson(path.join(repoDir, 'SUMMARY.json'), summary, { spaces: 2 });
    
    // Step 6: Final push of everything for this page
    console.log(`\n📍 Step 6: Final push of all data for page ${page}...`);
    await commitAndPushAll(page, repoDir, true);
    
    // Step 7: Clean up local repository to save space
    console.log(`\n📍 Step 7: Cleaning up local repository...`);
    await fs.remove(repoDir);
    
    const duration = (Date.now() - pageStartTime) / 1000;
    console.log(`\n${'='.repeat(60)}`);
    console.log(`✅ PAGE ${page} COMPLETE!`);
    console.log(`   Movies: ${successCount}/${movieIds.length} successful`);
    console.log(`   Duration: ${duration.toFixed(1)} seconds`);
    console.log(`   Repository: ${repoUrl}`);
    console.log(`${'='.repeat(60)}`);
    
    // Update global summary
    globalSummary.pages.push({
        page: page,
        total_movies: movieIds.length,
        successful: successCount,
        failed: failCount,
        repository: repoUrl,
        repository_name: repoName,
        duration_seconds: duration,
        timestamp: new Date().toISOString()
    });
    
    globalSummary.totalMoviesFound += movieIds.length;
    globalSummary.totalSuccessfulDownloads += successCount;
    globalSummary.totalFailedDownloads += failCount;
    globalSummary.processedPages++;
    
    await saveGlobalSummary();
    await saveGlobalErrorLog();
    
    return { totalMovies: movieIds.length, successful: successCount, failed: failCount };
}

// Main function - process pages ONE BY ONE with complete push before next
async function processAllPagesSequentially(startPage = 1, endPage = 35) {
    globalSummary.startTime = new Date().toISOString();
    globalSummary.totalPages = endPage - startPage + 1;
    
    console.log(`\n${'='.repeat(70)}`);
    console.log(`🚀 STARTING SEQUENTIAL PROCESSING`);
    console.log(`${'='.repeat(70)}`);
    console.log(`📊 Pages to process: ${startPage} to ${endPage} (${globalSummary.totalPages} pages)`);
    console.log(`📦 Repository pattern: ${BASE_REPO_NAME}-{page}`);
    console.log(`✨ Each page will be COMPLETELY processed and pushed before moving to next`);
    console.log(`${'='.repeat(70)}\n`);
    
    for (let page = startPage; page <= endPage; page++) {
        console.log(`\n🔄 ========== PROCESSING PAGE ${page}/${endPage} ==========`);
        
        try {
            // Process current page completely (including final push)
            const pageResult = await processSinglePageComplete(page);
            
            // Verify that the page was successfully pushed
            if (pageResult.totalMovies > 0 || pageResult.successful > 0) {
                console.log(`\n✅ Page ${page} VERIFIED - All data pushed to ${BASE_REPO_NAME}-${page}`);
            } else if (pageResult.error) {
                console.log(`\n⚠️ Page ${page} had errors: ${pageResult.error}`);
            }
            
        } catch (error) {
            console.error(`\n❌ CRITICAL ERROR processing page ${page}:`, error.message);
            addErrorToLog('critical_page_error', page, null, error.message);
        }
        
        // Wait before moving to next page
        if (page < endPage) {
            console.log(`\n⏳ Waiting 3 seconds before processing page ${page + 1}...`);
            await sleep(3000);
        }
    }
    
    // Final summary
    globalSummary.endTime = new Date().toISOString();
    globalSummary.duration_seconds = (new Date(globalSummary.endTime) - new Date(globalSummary.startTime)) / 1000;
    await saveGlobalSummary();
    await saveGlobalErrorLog();
    
    console.log(`\n${'='.repeat(70)}`);
    console.log(`🎉 ALL PAGES PROCESSED SUCCESSFULLY!`);
    console.log(`${'='.repeat(70)}`);
    console.log(`\n📊 FINAL STATISTICS:`);
    console.log(`   Pages processed: ${globalSummary.processedPages}/${globalSummary.totalPages}`);
    console.log(`   Total movies found: ${globalSummary.totalMoviesFound}`);
    console.log(`   Total successful: ${globalSummary.totalSuccessfulDownloads}`);
    console.log(`   Total failed: ${globalSummary.totalFailedDownloads}`);
    console.log(`   Success rate: ${((globalSummary.totalSuccessfulDownloads / globalSummary.totalMoviesFound) * 100).toFixed(1)}%`);
    console.log(`   Total duration: ${globalSummary.duration_seconds.toFixed(1)} seconds (${(globalSummary.duration_seconds / 60).toFixed(1)} minutes)`);
    
    console.log(`\n📦 CREATED REPOSITORIES:`);
    globalSummary.pages.forEach(page => {
        if (page.repository) {
            console.log(`   ${page.repository_name}: ${page.repository}`);
            console.log(`      - ${page.total_movies} movies, ${page.successful} successful`);
        }
    });
    
    isScrapingComplete = true;
}

// Test FlareSolverr connection
async function testFlareSolverr() {
    try {
        const response = await axios.get('http://localhost:8191/v1', { timeout: 5000 });
        console.log('✅ FlareSolverr is connected');
        return true;
    } catch (error) {
        console.log('⚠️  FlareSolverr is not running, will use direct requests');
        return false;
    }
}

// Find working sitemap URL
async function findWorkingSitemapUrl(page) {
    const possibleUrls = [
        `https://missav.ws/sitemap_actresses_${page}.xml`,
        `https://missav.live/sitemap_actresses_${page}.xml`,
        `https://missav.ai/sitemap_actresses_${page}.xml`,
    ];
    
    for (const url of possibleUrls) {
        try {
            const response = await axios.get(url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Accept': 'application/xml,text/xml,*/*'
                },
                timeout: 10000,
                validateStatus: function (status) {
                    return status === 200;
                }
            });
            
            if (response.data && response.data.includes('<urlset')) {
                console.log(`  ✅ Found working URL: ${url}`);
                return { url, data: response.data };
            }
        } catch (error) {
            // Continue to next URL
        }
    }
    return null;
}

// Helper functions
async function saveGlobalErrorLog() {
    if (globalErrorLog.length > 0) {
        const errorLogPath = path.join(ROOT_DIR, 'error_log.json');
        const errorLogData = {
            timestamp: new Date().toISOString(),
            total_errors: globalErrorLog.length,
            errors: globalErrorLog
        };
        await fs.writeJson(errorLogPath, errorLogData, { spaces: 2 });
    }
}

async function saveGlobalSummary() {
    const summaryPath = path.join(ROOT_DIR, 'summary.json');
    await fs.writeJson(summaryPath, globalSummary, { spaces: 2 });
    console.log(`📊 Global summary saved`);
}

function addErrorToLog(errorType, page, movieId, errorMessage, url = null) {
    const errorEntry = {
        timestamp: new Date().toISOString(),
        type: errorType,
        page: page,
        movieId: movieId,
        error: errorMessage,
        url: url
    };
    globalErrorLog.push(errorEntry);
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Express endpoints (keeping essential ones)
app.get('/scraping-status', (req, res) => {
    res.json({ 
        isScrapingComplete,
        summary: {
            processedPages: globalSummary.processedPages,
            totalPages: globalSummary.totalPages,
            totalMoviesFound: globalSummary.totalMoviesFound,
            totalSuccessfulDownloads: globalSummary.totalSuccessfulDownloads,
            totalFailedDownloads: globalSummary.totalFailedDownloads,
            duration_seconds: globalSummary.duration_seconds
        }
    });
});

app.get('/summary', async (req, res) => {
    try {
        const summaryPath = path.join(ROOT_DIR, 'summary.json');
        if (await fs.pathExists(summaryPath)) {
            const summary = await fs.readJson(summaryPath);
            res.json(summary);
        } else {
            res.json({ message: 'No summary found' });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Start the application
app.listen(PORT, async () => {
    console.log(`✅ Server running on http://localhost:${PORT}`);
    console.log(`📦 Repositories will be created for each page`);
    
    await testFlareSolverr();
    
    if (!GITHUB_TOKEN) {
        console.log('❌ ERROR: No GITHUB_TOKEN environment variable found!');
        console.log('❌ Please set GITHUB_TOKEN in GitHub Secrets');
        process.exit(1);
    } else {
        console.log(`✅ GitHub token found (user: ${GITHUB_USERNAME})`);
    }
    
    // Start sequential processing
    const startPage = parseInt(process.env.START_PAGE) || 1;
    const endPage = parseInt(process.env.END_PAGE) || 35;
    
    await processAllPagesSequentially(startPage, endPage);
    
    console.log('\n🛑 All done! Shutting down...');
    setTimeout(() => process.exit(0), 3000);
});
