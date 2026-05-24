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

// FlareSolverr configuration - FIXED
const FLARESOLVERR_URL = 'http://localhost:8191/v1';
let USE_FLARESOLVERR = false; // Default to false, will test

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

// Test FlareSolverr correctly
async function testFlareSolverr() {
    try {
        // FlareSolverr expects POST requests, not GET
        const response = await axios.post(FLARESOLVERR_URL, {
            cmd: 'request.get',
            url: 'https://httpbin.org/anything',
            maxTimeout: 10000
        }, {
            timeout: 10000,
            headers: {
                'Content-Type': 'application/json'
            }
        });
        
        if (response.data && response.data.status === 'ok') {
            console.log('✅ FlareSolverr is connected and working');
            return true;
        }
        console.log('⚠️ FlareSolverr responded but not OK');
        return false;
    } catch (error) {
        console.log('⚠️ FlareSolverr is not running, will use direct requests');
        return false;
    }
}

// Function to fetch with FlareSolverr (for problematic pages)
async function fetchWithFlareSolverr(url) {
    try {
        const response = await axios.post(FLARESOLVERR_URL, {
            cmd: 'request.get',
            url: url,
            maxTimeout: 60000,
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        });
        
        if (response.data && response.data.status === 'ok') {
            return response.data.solution.response;
        }
        throw new Error('FlareSolverr returned non-OK status');
    } catch (error) {
        throw new Error(`FlareSolverr failed: ${error.message}`);
    }
}

// Function to fetch with fallback (direct first, then FlareSolverr)
async function fetchWithFallback(url, useFlareSolverrOnly = false) {
    // If we must use FlareSolverr only
    if (useFlareSolverrOnly) {
        console.log(`  Using FlareSolverr for ${url.substring(0, 50)}...`);
        return await fetchWithFlareSolverr(url);
    }
    
    // Try direct first (faster)
    for (let attempt = 1; attempt <= 2; attempt++) {
        try {
            const response = await axios.get(url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.5',
                },
                timeout: 30000,
                maxRedirects: 5
            });
            
            if (response.data && response.data.length > 1000) {
                return response.data;
            }
        } catch (error) {
            if (error.response?.status === 403 || error.response?.status === 503) {
                console.log(`  Direct blocked (${error.response.status}), trying FlareSolverr...`);
                break; // Switch to FlareSolverr
            }
            if (attempt === 2) {
                throw error;
            }
        }
    }
    
    // If direct failed, use FlareSolverr
    return await fetchWithFlareSolverr(url);
}

// Function to create GitHub repository with better error handling
async function createGitHubRepository(repoName, description = '') {
    if (!GITHUB_TOKEN) {
        console.log('⚠️ No GITHUB_TOKEN found');
        return false;
    }

    try {
        console.log(`  Creating repository: ${repoName}...`);
        
        // First check if repo exists
        try {
            const checkResponse = await axios.get(`https://api.github.com/repos/${GITHUB_USERNAME}/${repoName}`, {
                headers: {
                    'Authorization': `token ${GITHUB_TOKEN}`,
                    'Accept': 'application/vnd.github.v3+json'
                }
            });
            if (checkResponse.data) {
                console.log(`  📚 Repository ${repoName} already exists`);
                return checkResponse.data.clone_url;
            }
        } catch (checkError) {
            if (checkError.response?.status !== 404) {
                console.log(`  Check error: ${checkError.response?.status}`);
            }
            // 404 means repo doesn't exist, continue to create
        }
        
        // Create new repository
        const response = await axios.post('https://api.github.com/user/repos', {
            name: repoName,
            description: description,
            private: false,
            auto_init: true,
            has_issues: true,
            has_projects: false,
            has_wiki: false
        }, {
            headers: {
                'Authorization': `token ${GITHUB_TOKEN}`,
                'Accept': 'application/vnd.github.v3+json',
                'Content-Type': 'application/json'
            }
        });
        
        console.log(`  ✅ Created repository: ${repoName}`);
        return response.data.clone_url;
        
    } catch (error) {
        console.error(`  ❌ Failed to create repository: ${error.response?.data?.message || error.message}`);
        if (error.response?.data?.message === 'Resource not accessible by integration') {
            console.error(`  ⚠️ GitHub token needs 'write' permission for repositories`);
            console.error(`  ⚠️ Go to Settings → Actions → General → Workflow permissions → Read and write`);
        }
        return false;
    }
}

// Process a single sitemap page completely
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
    
    // Step 2: Fetch and parse sitemap (use FlareSolverr for sitemap if needed)
    console.log(`\n📍 Step 2: Fetching sitemap for page ${page}...`);
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
        
        // We'll push to GitHub later after downloading all movies
    } else {
        const errorMsg = `Could not find sitemap for page ${page}`;
        console.log(`  ❌ ${errorMsg}`);
        addErrorToLog('sitemap_not_found', page, null, errorMsg);
        return { totalMovies: 0, successful: 0, failed: 0, error: errorMsg };
    }
    
    if (movieIds.length === 0) {
        console.log(`  ⚠️ No movie IDs found for page ${page}, skipping...`);
        return { totalMovies: 0, successful: 0, failed: 0 };
    }
    
    // Step 3: Download all movies for this page using FlareSolverr
    console.log(`\n📍 Step 3: Downloading ${movieIds.length} movies for page ${page}...`);
    console.log(`  💡 Using FlareSolverr for all downloads to avoid blocks`);
    
    let successCount = 0;
    let failCount = 0;
    
    // Create temp directory for this page
    const tempDir = path.join(__dirname, 'temp', `page-${page}`);
    await fs.ensureDir(tempDir);
    const dataDir = path.join(tempDir, 'data');
    await fs.ensureDir(dataDir);
    
    for (let i = 0; i < movieIds.length; i++) {
        const movieId = movieIds[i];
        const movieUrl = `https://missav.ws/en/actresses/${movieId}`;
        const htmlFilePath = path.join(dataDir, `${movieId}.html`);
        const metadataPath = path.join(dataDir, `${movieId}.json`);
        
        // Check if we already downloaded (in case of resume)
        if (await fs.pathExists(htmlFilePath)) {
            const stats = await fs.stat(htmlFilePath);
            if (stats.size > 1000) {
                console.log(`  ⏭️  [${i + 1}/${movieIds.length}] ${movieId} - already downloaded`);
                successCount++;
                continue;
            }
        }
        
        try {
            // Try multiple URL patterns with FlareSolverr
            const urlsToTry = [
                `https://missav.ws/en/actresses/${movieId}`,
                `https://missav.com/en/actresses/${movieId}`,
                `https://missav.ai/en/actresses/${movieId}`
            ];
            
            let htmlContent = null;
            let successfulUrl = null;
            
            for (const tryUrl of urlsToTry) {
                try {
                    // Always use FlareSolverr for movie pages (they have Cloudflare)
                    htmlContent = await fetchWithFlareSolverr(tryUrl);
                    if (htmlContent && htmlContent.length > 1000) {
                        successfulUrl = tryUrl;
                        console.log(`  ✅ [${i + 1}/${movieIds.length}] ${movieId} (${(htmlContent.length / 1024).toFixed(1)} KB) - via FlareSolverr`);
                        break;
                    }
                } catch (e) {
                    // Try next URL
                }
            }
            
            if (!htmlContent) {
                throw new Error('Could not fetch from any URL even with FlareSolverr');
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
            
            successCount++;
            
            // Small delay to avoid rate limiting
            await sleep(1000);
            
        } catch (error) {
            console.error(`  ❌ [${i + 1}/${movieIds.length}] ${movieId} - FAILED: ${error.message}`);
            failCount++;
            addErrorToLog('movie_fetch', page, movieId, error.message, movieUrl);
            
            const errorFilePath = path.join(dataDir, `${movieId}.error.txt`);
            await fs.writeFile(errorFilePath, `Error: ${error.message}\nURL: ${movieUrl}\nTime: ${new Date().toISOString()}`, 'utf-8');
        }
        
        // Update progress every 10 movies
        if ((i + 1) % 10 === 0) {
            console.log(`  📊 Progress: ${successCount}/${i + 1} successful (${Math.round(successCount/(i+1)*100)}%)`);
        }
    }
    
    // Step 4: Push everything to GitHub
    console.log(`\n📍 Step 4: Pushing all data to GitHub repository ${repoName}...`);
    
    const pushSuccess = await pushToGitHub(page, tempDir, repoUrl, movieIds.length, successCount, failCount);
    
    if (pushSuccess) {
        console.log(`  ✅ Successfully pushed all data to ${repoUrl}`);
    } else {
        console.log(`  ⚠️ Failed to push to GitHub, data saved locally in ${tempDir}`);
    }
    
    // Step 5: Clean up temp directory
    console.log(`\n📍 Step 5: Cleaning up...`);
    await fs.remove(tempDir);
    
    const duration = (Date.now() - pageStartTime) / 1000;
    console.log(`\n${'='.repeat(60)}`);
    console.log(`✅ PAGE ${page} COMPLETE!`);
    console.log(`   Movies: ${successCount}/${movieIds.length} successful (${Math.round(successCount/movieIds.length*100)}%)`);
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

// Function to push to GitHub
async function pushToGitHub(page, sourceDir, repoUrl, totalMovies, successCount, failCount) {
    if (!GITHUB_TOKEN) return false;
    
    const cloneDir = path.join(__dirname, 'temp_repos', `page-${page}`);
    
    try {
        // Remove existing directory if any
        if (await fs.pathExists(cloneDir)) {
            await fs.remove(cloneDir);
        }
        
        // Clone the repository
        const repoUrlWithToken = repoUrl.replace('https://', `https://${GITHUB_USERNAME}:${GITHUB_TOKEN}@`);
        await execPromise(`git clone ${repoUrlWithToken} ${cloneDir}`);
        
        // Copy all files
        await fs.copy(path.join(sourceDir, 'data'), path.join(cloneDir, 'data'));
        
        // Create summary files
        const summary = {
            page: page,
            total_movies: totalMovies,
            successful_downloads: successCount,
            failed_downloads: failCount,
            success_rate: `${((successCount / totalMovies) * 100).toFixed(1)}%`,
            timestamp: new Date().toISOString(),
            repo_name: `jav-actress-${page}`,
            repo_url: repoUrl
        };
        
        await fs.writeJson(path.join(cloneDir, 'SUMMARY.json'), summary, { spaces: 2 });
        
        const movieIdsList = await fs.readdir(path.join(cloneDir, 'data'));
        const htmlFiles = movieIdsList.filter(f => f.endsWith('.html'));
        await fs.writeJson(path.join(cloneDir, 'movie_ids.json'), {
            page: page,
            total: htmlFiles.length,
            movie_ids: htmlFiles.map(f => f.replace('.html', ''))
        }, { spaces: 2 });
        
        // Commit and push
        await execPromise(`git config user.name "github-actions"`, { cwd: cloneDir });
        await execPromise(`git config user.email "actions@github.com"`, { cwd: cloneDir });
        await execPromise(`git add .`, { cwd: cloneDir });
        await execPromise(`git commit -m "Add data for page ${page}: ${successCount}/${totalMovies} movies"`, { cwd: cloneDir });
        await execPromise(`git push origin main`, { cwd: cloneDir });
        
        // Clean up
        await fs.remove(cloneDir);
        
        return true;
    } catch (error) {
        console.error(`  Push failed: ${error.message}`);
        return false;
    }
}

// Find working sitemap URL (use FlareSolverr for sitemaps too)
async function findWorkingSitemapUrl(page) {
    const possibleUrls = [
        `https://missav.ws/sitemap_actresses_${page}.xml`,
        `https://missav.live/sitemap_actresses_${page}.xml`,
        `https://missav.ai/sitemap_actresses_${page}.xml`,
    ];
    
    for (const url of possibleUrls) {
        try {
            console.log(`  Trying: ${url}`);
            // Try direct first
            try {
                const response = await axios.get(url, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                        'Accept': 'application/xml,text/xml,*/*'
                    },
                    timeout: 10000
                });
                
                if (response.data && response.data.includes('<urlset')) {
                    console.log(`  ✅ Found working URL (direct): ${url}`);
                    return { url, data: response.data };
                }
            } catch (directError) {
                // If direct fails, try FlareSolverr
                if (directError.response?.status === 403 || directError.response?.status === 503) {
                    console.log(`  Direct blocked, trying FlareSolverr...`);
                    const flareData = await fetchWithFlareSolverr(url);
                    if (flareData && flareData.includes('<urlset')) {
                        console.log(`  ✅ Found working URL (FlareSolverr): ${url}`);
                        return { url, data: flareData };
                    }
                }
            }
        } catch (error) {
            // Continue to next URL
        }
    }
    return null;
}

// Main function - process pages sequentially
async function processAllPagesSequentially(startPage = 1, endPage = 100) {
    globalSummary.startTime = new Date().toISOString();
    globalSummary.totalPages = endPage - startPage + 1;
    
    console.log(`\n${'='.repeat(70)}`);
    console.log(`🚀 STARTING SEQUENTIAL PROCESSING`);
    console.log(`${'='.repeat(70)}`);
    console.log(`📊 Pages to process: ${startPage} to ${endPage} (${globalSummary.totalPages} pages)`);
    console.log(`📦 Repository pattern: ${BASE_REPO_NAME}-{page}`);
    console.log(`🛡️  Using FlareSolverr for all downloads to bypass Cloudflare`);
    console.log(`${'='.repeat(70)}\n`);
    
    for (let page = startPage; page <= endPage; page++) {
        console.log(`\n🔄 ========== PROCESSING PAGE ${page}/${endPage} ==========`);
        
        try {
            const pageResult = await processSinglePageComplete(page);
            
            if (pageResult.totalMovies > 0 || pageResult.successful > 0) {
                console.log(`\n✅ Page ${page} COMPLETE - ${pageResult.successful}/${pageResult.totalMovies} movies saved to ${BASE_REPO_NAME}-${page}`);
            } else if (pageResult.error) {
                console.log(`\n⚠️ Page ${page} had errors: ${pageResult.error}`);
            }
            
        } catch (error) {
            console.error(`\n❌ CRITICAL ERROR processing page ${page}:`, error.message);
            addErrorToLog('critical_page_error', page, null, error.message);
        }
        
        // Wait before moving to next page
        if (page < endPage) {
            console.log(`\n⏳ Waiting 5 seconds before processing page ${page + 1}...`);
            await sleep(5000);
        }
    }
    
    // Final summary
    globalSummary.endTime = new Date().toISOString();
    globalSummary.duration_seconds = (new Date(globalSummary.endTime) - new Date(globalSummary.startTime)) / 1000;
    await saveGlobalSummary();
    await saveGlobalErrorLog();
    
    console.log(`\n${'='.repeat(70)}`);
    console.log(`🎉 ALL PAGES PROCESSED!`);
    console.log(`${'='.repeat(70)}`);
    console.log(`\n📊 FINAL STATISTICS:`);
    console.log(`   Pages processed: ${globalSummary.processedPages}/${globalSummary.totalPages}`);
    console.log(`   Total movies found: ${globalSummary.totalMoviesFound}`);
    console.log(`   Total successful: ${globalSummary.totalSuccessfulDownloads}`);
    console.log(`   Total failed: ${globalSummary.totalFailedDownloads}`);
    console.log(`   Success rate: ${((globalSummary.totalSuccessfulDownloads / globalSummary.totalMoviesFound) * 100).toFixed(1)}%`);
    console.log(`   Total duration: ${(globalSummary.duration_seconds / 60).toFixed(1)} minutes`);
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

// Start the application
app.listen(PORT, async () => {
    console.log(`✅ Server running on http://localhost:${PORT}`);
    
    // Test FlareSolverr correctly
    const flaresolverrWorking = await testFlareSolverr();
    USE_FLARESOLVERR = flaresolverrWorking;
    
    if (!GITHUB_TOKEN) {
        console.log('❌ ERROR: No GITHUB_TOKEN found!');
        console.log('❌ Please ensure GitHub token is set in secrets');
        process.exit(1);
    } else {
        console.log(`✅ GitHub token found (user: ${GITHUB_USERNAME})`);
    }
    
    if (USE_FLARESOLVERR) {
        console.log(`✅ FlareSolverr is working - will use it for all downloads`);
    } else {
        console.log(`⚠️ FlareSolverr not available - may encounter Cloudflare blocks`);
    }
    
    // Start sequential processing
    const startPage = parseInt(process.env.START_PAGE) || 1;
    const endPage = parseInt(process.env.END_PAGE) || 35;
    
    await processAllPagesSequentially(startPage, endPage);
    
    console.log('\n🛑 All done! Shutting down...');
    setTimeout(() => process.exit(0), 5000);
});
