import path from "path";

export default function defaultOptions() {
    const draftsDir = path.join(__dirname, "../content/drafts");
    const publishDir = path.join(__dirname, "../content/published");
    const contentDir = path.join(__dirname, "../public/content");
    const indexesDir = path.join(contentDir, "./indexes");

    const markdownItOpts = {
        html: true,        // Enable HTML tags in source
        breaks: false,        // Convert '\n' in paragraphs into <br>
        linkify: true,
    }

    const htmlMinifyOpts = {
        minifyCSS: true,
        removeComments: true,
    }

    const grayMatterOpts = {
        excerpt: undefined,
        excerpt_separator: undefined,
    }

    return {
        draftsDir, contentDir, indexesDir, publishDir,
        markdownItOpts, htmlMinifyOpts, grayMatterOpts
    };
}

