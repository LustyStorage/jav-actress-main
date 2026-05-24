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
const GITHUB_USERNAME = process.env.GITHUB_USERNAME || 'LustryStorage';
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
            console.log('✅ FlareSolverr ready');
            return true;
        }
        return false;
    } catch (error) {
        console.error('❌ FlareSolverr required! Make sure it\'s running on port 8191');
        return false;
    }
}

// Fetch sitemap with simple axios (no FlareSolverr)
async function fetchSitemap(url) {
    const response = await axios.get(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': 'application/xml,text/xml,*/*'
        },
        timeout: 10000
    });
    return response.data;
}

// Fetch movie HTML with FlareSolverr
async function fetchMovieWithFlareSolverr(movieId) {
    const urlsToTry = [
        `https://missav.ws/en/actresses/${movieId}`,
        `https://missav.com/en/actresses/${movieId}`,
        `https://missav.ai/en/actresses/${movieId}`
    ];
    
    for (const url of urlsToTry) {
        try {
            const response = await axios.post('http://localhost:8191/v1', {
                cmd: 'request.get',
                url: url,
                maxTimeout: 60000,
                userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }, {
                headers: { 'Content-Type': 'application/json' },
                timeout: 65000
            });
            
            if (response.data && response.data.status === 'ok') {
                return response.data.solution.response;
            }
        } catch (error) {
            // Try next URL
        }
    }
    throw new Error(`Failed to fetch ${movieId} with FlareSolverr`);
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
            const data = await fetchSitemap(url);
            if (data && data.includes('<urlset')) {
                return { url, data };
            }
        } catch (error) {
            // Continue to next URL
        }
    }
    return null;
}

// Create repository using PAT
async function createGitHubRepository(repoName) {
    if (!GITHUB_TOKEN) {
        throw new Error('No GITHUB_TOKEN found');
    }

    try {
        const checkResponse = await axios.get(`https://api.github.com/repos/${GITHUB_USERNAME}/${repoName}`, {
            headers: {
                'Authorization': `token ${GITHUB_TOKEN}`,
                'Accept': 'application/vnd.github.v3+json'
            }
        });
        return checkResponse.data.clone_url;
    } catch (checkError) {
        // Repository doesn't exist, create it
    }
    
    const response = await axios.post('https://api.github.com/user/repos', {
        name: repoName,
        description: `JAV actress data for page ${repoName.split('-').pop()}`,
        private: false,
        auto_init: true
    }, {
        headers: {
            'Authorization': `token ${GITHUB_TOKEN}`,
            'Accept': 'application/vnd.github.v3+json',
            'Content-Type': 'application/json'
        }
    });
    
    console.log(`  Created: ${repoName}`);
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

// Process single page
async function processSinglePage(page) {
    console.log(`\n📄 Page ${page}`);
    
    const repoName = `${BASE_REPO_NAME}-${page}`;
    const repoUrl = await createGitHubRepository(repoName);
    
    // Get sitemap (simple axios)
    const sitemapResult = await findWorkingSitemapUrl(page);
    
    let movieIds = [];
    if (sitemapResult && sitemapResult.data) {
        const $ = cheerio.load(sitemapResult.data, { xmlMode: true });
        
        $('url').each((i, el) => {
            const loc = $(el).find('loc').text().trim();
            if (loc) {
                const slug = loc.split('/').pop();
                if (slug && !slug.includes('.xml')) {
                    if (globalMovieIds.has(slug)) {
                        duplicateMovies.push({
                            movieId: slug,
                            page: page,
                            duplicate_of_page: Array.from(globalMovieIds).indexOf(slug) + 1
                        });
                    } else {
                        globalMovieIds.add(slug);
                        movieIds.push(slug);
                    }
                }
            }
        });
    }
    
    if (movieIds.length === 0) {
        console.log(`  No new movies`);
        return { total: 0, successful: 0 };
    }
    
    console.log(`  Downloading ${movieIds.length} movies with FlareSolverr...`);
    const dataDir = path.join(__dirname, 'temp', `page-${page}`, 'data');
    await fs.ensureDir(dataDir);
    
    let successCount = 0;
    
    // Download movies with FlareSolverr
    for (let i = 0; i < movieIds.length; i++) {
        const movieId = movieIds[i];
        
        try {
            const html = await fetchMovieWithFlareSolverr(movieId);
            await fs.writeFile(path.join(dataDir, `${movieId}.html`), html);
            successCount++;
            
            // Progress indicator
            if ((i + 1) % 20 === 0 || i + 1 === movieIds.length) {
                console.log(`    ${successCount}/${movieIds.length}`);
            }
        } catch (error) {
            // Silent fail
        }
    }
    
    console.log(`  ✅ ${successCount}/${movieIds.length} downloaded`);
    
    // Save duplicate report
    const pageDuplicates = duplicateMovies.filter(d => d.page === page);
    if (pageDuplicates.length > 0) {
        await fs.writeJson(path.join(dataDir, '..', 'duplicates.json'), {
            page: page,
            total_duplicates_found: pageDuplicates.length,
            duplicates: pageDuplicates
        }, { spaces: 2 });
    }
    
    console.log(`  Pushing to GitHub...`);
    await pushToGitHub(page, dataDir, repoUrl);
    
    await fs.remove(path.join(__dirname, 'temp', `page-${page}`));
    
    return { total: movieIds.length, successful: successCount };
}

// Discover movies endpoint
app.get('/discover/movie', async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 50;
        const offset = parseInt(req.query.offset) || 0;
        
        const allMovies = [];
        
        for (let p = 1; p <= globalSummary.processedPages; p++) {
            const repoDataPath = path.join(__dirname, 'temp_repos', `page-${p}`, 'data');
            if (await fs.pathExists(repoDataPath)) {
                const files = await fs.readdir(repoDataPath);
                const htmlFiles = files.filter(f => f.endsWith('.html'));
                
                for (const file of htmlFiles) {
                    const movieId = file.replace('.html', '');
                    allMovies.push({
                        id: movieId,
                        title: movieId,
                        page: p,
                        local_html: `/pages/${p}/${file}`,
                        poster_path: `https://fourhoi.com/${encodeURIComponent(movieId)}/cover.jpg`
                    });
                }
            }
        }
        
        const uniqueMovies = new Map();
        for (const movie of allMovies) {
            if (!uniqueMovies.has(movie.id)) {
                uniqueMovies.set(movie.id, movie);
            }
        }
        
        const results = Array.from(uniqueMovies.values()).slice(offset, offset + limit);
        
        res.json({
            page: page,
            limit: limit,
            offset: offset,
            total: uniqueMovies.size,
            results: results
        });
        
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get duplicates report
app.get('/discover/duplicates', async (req, res) => {
    res.json({
        total_duplicates: duplicateMovies.length,
        duplicates: duplicateMovies,
        unique_movies: globalMovieIds.size
    });
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
    console.log('📡 Sitemap: Simple axios');
    console.log('🎬 Movies: FlareSolverr\n');
    
    const startPage = parseInt(process.env.START_PAGE) || 1;
    const endPage = parseInt(process.env.END_PAGE) || 35;
    
    globalSummary.startTime = new Date().toISOString();
    globalSummary.totalPages = endPage - startPage + 1;
    
    for (let page = startPage; page <= endPage; page++) {
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
            
            // Save progress
            await fs.writeJson('./summary.json', globalSummary, { spaces: 2 });
            
        } catch (error) {
            console.error(`Failed page ${page}:`, error.message);
        }
        
        if (page < endPage) {
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
    }
    
    globalSummary.endTime = new Date().toISOString();
    globalSummary.duration_seconds = (new Date(globalSummary.endTime) - new Date(globalSummary.startTime)) / 1000;
    
    await fs.writeJson('./summary.json', globalSummary, { spaces: 2 });
    
    console.log('\n🎉 ALL DONE!');
    console.log(`Pages: ${globalSummary.processedPages}/${globalSummary.totalPages}`);
    console.log(`Unique Movies: ${globalMovieIds.size}`);
    console.log(`Success: ${globalSummary.totalSuccessfulDownloads}/${globalSummary.totalMoviesFound}`);
    console.log(`Time: ${globalSummary.duration_seconds.toFixed(1)}s`);
}

// Start server
app.listen(PORT, async () => {
    console.log(`Server on port ${PORT}`);
    
    const flaresolverrOk = await testFlareSolverr();
    if (!flaresolverrOk) {
        process.exit(1);
    }
    
    if (!GITHUB_TOKEN) {
        console.error('❌ GITHUB_TOKEN required!');
        process.exit(1);
    }
    
    await main();
    setTimeout(() => process.exit(0), 3000);
});
