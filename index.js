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

// Store all movie IDs across pages to detect duplicates
let globalMovieIds = new Set();
let duplicateMovies = [];

// Test FlareSolverr
async function testFlareSolverr() {
    try {
        const response = await axios.post('http://localhost:8191/v1', {
            cmd: 'request.get',
            url: 'https://www.google.com',
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

// Fetch with FlareSolverr (for movie HTML downloads)
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
        
        await fs.copy(dataDir, path.join(cloneDir, 'data'));
        
        const files = await fs.readdir(path.join(cloneDir, 'data'));
        const htmlFiles = files.filter(f => f.endsWith('.html'));
        
        const summary = {
            page: page,
            total_movies: htmlFiles.length,
            timestamp: new Date().toISOString(),
            repo_name: `jav-actress-${page}`
        };
        await fs.writeJson(path.join(cloneDir, 'SUMMARY.json'), summary, { spaces: 2 });
        
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

// Process single page - DOWNLOAD ALL MOVIES
async function processSinglePage(page) {
    console.log(`\n📄 STARTING PAGE ${page}`);
    
    const repoName = `${BASE_REPO_NAME}-${page}`;
    const repoUrl = await createGitHubRepository(repoName);
    
    console.log(`  Fetching sitemap for page ${page}...`);
    const sitemapUrl = `https://missav.ws/sitemap_actresses_${page}.xml`;
    
    let movieIds = [];
    try {
        const response = await axios.get(sitemapUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': 'application/xml,text/xml,*/*'
            },
            timeout: 10000
        });
        
        const sitemapContent = response.data;
        const $ = cheerio.load(sitemapContent, { xmlMode: true });
        
        $('url').each((i, el) => {
            const loc = $(el).find('loc').text().trim();
            if (loc) {
                const slug = loc.split('/').pop();
                if (slug && !slug.includes('.xml')) {
                    // Check for duplicates across pages
                    if (globalMovieIds.has(slug)) {
                        duplicateMovies.push({
                            movieId: slug,
                            page: page,
                            duplicate_of_page: Array.from(globalMovieIds).indexOf(slug) + 1
                        });
                        // console.log(`  ⚠️ Duplicate found: ${slug} (already in page ${Array.from(globalMovieIds).indexOf(slug) + 1})`);
                    } else {
                        globalMovieIds.add(slug);
                        movieIds.push(slug);
                    }
                }
            }
        });
        
        // console.log(`  Found ${movieIds.length} new unique movie IDs (${globalMovieIds.size} total unique so far)`);
        if (duplicateMovies.length > 0) {
            // console.log(`  Total duplicates detected across pages: ${duplicateMovies.length}`);
        }
    } catch (error) {
        console.error(`  Failed to fetch sitemap: ${error.message}`);
        return { total: 0, successful: 0 };
    }
    
    if (movieIds.length === 0) {
        // console.log(`  No new movies found for page ${page} (all duplicates)`);
        return { total: 0, successful: 0 };
    }
    
    // Download ALL movies (no limit)
    // console.log(`  Downloading... ${movieIds.length}`);
    const dataDir = path.join(__dirname, 'temp', `page-${page}`, 'data');
    await fs.ensureDir(dataDir);
    
    let successCount = 0;
    
    for (let i = 0; i < movieIds.length; i++) {
        const movieId = movieIds[i];
        const movieUrl = `https://missav.ws/en/actresses/${movieId}`;
        
        try {
            // console.log(`    [${i+1}/${movieIds.length}] ${movieId}`);
            const html = await fetchWithFlareSolverr(movieUrl);
            await fs.writeFile(path.join(dataDir, `${movieId}.html`), html);
            successCount++;
            
            // Save progress every 10 movies
            if ((i + 1) % 10 === 0) {
                // console.log(`    Progress: ${successCount}/${i+1} (${Math.round(successCount/(i+1)*100)}%)`);
            }
            
            await new Promise(resolve => setTimeout(resolve, 1000));
        } catch (error) {
            console.error(`    Failed: ${error.message}`);
        }
    }
    
    // Save duplicate report
    if (duplicateMovies.length > 0) {
        await fs.writeJson(path.join(dataDir, '..', 'duplicates.json'), {
            page: page,
            total_duplicates_found: duplicateMovies.length,
            duplicates: duplicateMovies.filter(d => d.page === page)
        }, { spaces: 2 });
    }
    
    console.log(`  Pushing to GitHub...`);
    await pushToGitHub(page, dataDir, repoUrl);
    
    await fs.remove(path.join(__dirname, 'temp', `page-${page}`));
    
    console.log(`✅ Page ${page} complete: ${successCount}/${movieIds.length} downloaded`);
    
    return { total: movieIds.length, successful: successCount };
}

// Discover movies endpoint with duplicate filtering
app.get('/discover/movie', async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 50;
        const offset = parseInt(req.query.offset) || 0;
        const search = req.query.search || '';
        
        // Read from all repositories or local storage
        const allMovies = [];
        const reposDir = path.join(__dirname, 'temp_repos');
        
        // Try to read from existing data
        for (let p = 1; p <= globalSummary.processedPages; p++) {
            const repoDataPath = path.join(__dirname, 'temp_repos', `page-${p}`, 'data');
            if (await fs.pathExists(repoDataPath)) {
                const files = await fs.readdir(repoDataPath);
                const htmlFiles = files.filter(f => f.endsWith('.html'));
                
                for (const file of htmlFiles) {
                    const movieId = file.replace('.html', '');
                    const metadataPath = path.join(repoDataPath, `${movieId}.json`);
                    let metadata = {};
                    
                    if (await fs.pathExists(metadataPath)) {
                        metadata = await fs.readJson(metadataPath);
                    }
                    
                    allMovies.push({
                        id: movieId,
                        title: metadata.title || movieId,
                        page: p,
                        local_html: `/pages/${p}/${file}`,
                        poster_path: `https://fourhoi.com/${encodeURIComponent(movieId)}/cover.jpg`,
                        fetched_at: metadata.fetched_at || null
                    });
                }
            }
        }
        
        // Filter duplicates (keep first occurrence)
        const uniqueMovies = new Map();
        for (const movie of allMovies) {
            if (!uniqueMovies.has(movie.id)) {
                uniqueMovies.set(movie.id, movie);
            } else {
                // console.log(`Duplicate filtered: ${movie.id} from page ${movie.page}`);
            }
        }
        
        let results = Array.from(uniqueMovies.values());
        
        // Apply search filter
        if (search) {
            results = results.filter(movie => 
                movie.id.toLowerCase().includes(search.toLowerCase()) || 
                movie.title.toLowerCase().includes(search.toLowerCase())
            );
        }
        
        // Apply pagination
        const total = results.length;
        const paginatedResults = results.slice(offset, offset + limit);
        
        res.json({
            page: page,
            limit: limit,
            offset: offset,
            total: total,
            unique_count: uniqueMovies.size,
            total_with_duplicates: allMovies.length,
            duplicates_filtered: allMovies.length - uniqueMovies.size,
            results: paginatedResults,
            source: 'local'
        });
        
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get duplicates report
app.get('/discover/duplicates', async (req, res) => {
    try {
        res.json({
            total_duplicates: duplicateMovies.length,
            duplicates: duplicateMovies,
            unique_movies: globalMovieIds.size
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get statistics
app.get('/stats', async (req, res) => {
    res.json({
        summary: globalSummary,
        unique_movies: globalMovieIds.size,
        duplicates_found: duplicateMovies.length,
        status: 'complete'
    });
});

// Main function
async function main() {
    console.log('🚀 Starting scraper...');
    
    const startPage = parseInt(process.env.START_PAGE) || 1;
    const endPage = parseInt(process.env.END_PAGE) || 35;
    
    globalSummary.startTime = new Date().toISOString();
    globalSummary.totalPages = endPage - startPage + 1;
    
    for (let page = startPage; page <= endPage; page++) {
        // console.log(`\n${'='.repeat(50)}`);
        console.log(`Processing page ${page}/${endPage}`);
        // console.log(`${'='.repeat(50)}`);
        
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
            
            // Save progress after each page
            await fs.writeJson('./summary.json', globalSummary, { spaces: 2 });
            await fs.writeJson('./duplicates.json', { 
                total_duplicates: duplicateMovies.length,
                duplicates: duplicateMovies,
                unique_movies: globalMovieIds.size
            }, { spaces: 2 });
            
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
    console.log(`Unique Movies: ${globalMovieIds.size}`);
    console.log(`Duplicates Found: ${duplicateMovies.length}`);
    console.log(`Movies: ${globalSummary.totalSuccessfulDownloads}/${globalSummary.totalMoviesFound}`);
}

// Start
app.listen(PORT, async () => {
    console.log(`Server on port ${PORT}`);
    // console.log(`📊 Discover endpoint: http://localhost:${PORT}/discover/movie`);
    // console.log(`📊 Duplicates report: http://localhost:${PORT}/discover/duplicates`);
    // console.log(`📊 Statistics: http://localhost:${PORT}/stats`);
    
    const flaresolverrOk = await testFlareSolverr();
    if (!flaresolverrOk) {
        console.error('❌ FlareSolverr is required for downloading HTML!');
        process.exit(1);
    }
    
    if (!GITHUB_TOKEN) {
        console.error('❌ GITHUB_TOKEN (PAT) is required!');
        process.exit(1);
    }
    
    await main();
    setTimeout(() => process.exit(0), 3000);
});
