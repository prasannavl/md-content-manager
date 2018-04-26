import fs from "fs-extra";
import path from "path";
import os from "os";
import _ from "lodash";
import chalk from "chalk";
import MarkdownIt from "markdown-it";
import htmlMinify from "html-minifier";
import commander from "commander";
import grayMatter from "gray-matter";
import slugify from "slugify";
import { consoleOut, getMonthString, walkFs, writeFile } from "./utils";
import { getIndexers } from "./indexers";
import defaultOptions from "./opts";

class BuildHelper {
	static processAll(inputDirPath, outputDirPath, options) {
		if (!fs.existsSync(inputDirPath)) return Promise.reject(`not found: ${inputDirPath}`);
		
		return walkFs(inputDirPath, (f, tasks) => {
			if (!f.stats.isDirectory() && f.path.match(/\.md$/i)) {
				let filePath = f.path;
				let p = BuildHelper.process(filePath, outputDirPath, options);
				tasks.add(p);
			}
		});
	}

	static process(inputFile, outputDir, options) {
		if (!fs.existsSync(inputFile)) return Promise.reject(`not found: ${inputFile}`);
		
		const { mode, verbose } = options;
		const isBuildMode = mode === RunMode.Build;
		
		if (verbose) {
			let fileBasePath = path.basename(inputFile);
			consoleOut(`processing ${fileBasePath}..`);
		}

		let configFactory = isBuildMode ? BuildHelper.prepareBuild : BuildHelper.preparePublish;

		return fs.readFile(inputFile, "utf-8")
			.then(data => {
				let basename = path.basename(inputFile, path.extname(inputFile));
				let config = configFactory(basename, data, options);
				return config;
			}).then(config => {
				let finalizer = isBuildMode ? BuildHelper.finalizeBuild : BuildHelper.finalizePublish;
				return finalizer(config, inputFile, outputDir, options);
			});
	}

	static finalizeBuild(config, inputFilePath, outputDirPath, options) {
		let { forceBuild, verbose } = options;
		let extName = ".json";
		let destPath = path.join(outputDirPath, config.url + extName);
		let shouldBuild = forceBuild ? Promise.resolve(true) : fs.exists(destPath)
			.then(exists => {
				if (exists) {
					let destStatPromise = fs.stat(destPath);
					let srcStatPromise = fs.stat(inputFilePath);
					return Promise.all([destStatPromise, srcStatPromise])
						.then(res => {
							let destChangeTime = res[0].mtime;
							let srcChangeTime = res[1].mtime;
							return srcChangeTime > destChangeTime;
						});
				}
				return true;
			}).catch(() => true);

		return shouldBuild
			.then(res => {
				if (res) {
					let data = JSON.stringify(config);
					return fs.ensureDir(path.dirname(destPath))
						.then(() => writeFile(path.basename(inputFilePath), destPath, data));
				} else {
					if (verbose) {
						consoleOut(chalk.red(`skipped ${path.basename(inputFilePath)}`));
					}
					return Promise.resolve();
				}
			});
	}
	
	static finalizePublish(config, inputFilePath, outputDirPath, options) {
		let extName = ".md";
		
		let date = config.date;
		let datePrefix = `${date.getFullYear()}-${getMonthString(date)}`;
		let urlPath;
		if (config.name && config.name.startsWith(datePrefix)) {
			urlPath = config.name;
		} else {
			urlPath = `${datePrefix}-${config.name}`;
		}
		
		let urlDirPath = path.join(outputDirPath, path.dirname(urlPath));
		let destPath = path.join(outputDirPath, urlPath + extName);
		let data = config.content;

		return fs.ensureDir(urlDirPath)
			.then(() => writeFile(path.basename(inputFilePath), destPath, data))
			.then(() => fs.remove(inputFilePath));
	}

    static prepareBuild(name, data, options) {
        let matter = grayMatter(data, options.grayMatterOpts);
        let config = matter.data;
        let markdownIt = MarkdownIt(options.markdownItOpts);
        let html = markdownIt.render(matter.content, {});
        // This is the content which is rendered markdown as html        
        config.content = htmlMinify.minify(html, options.htmlMinifyOpts);
        return config;
	}

    static preparePublish(name, data, options) {
        let matter = grayMatter(data, options.grayMatterOpts);
        let config = matter.data;
		// setup config
		if (!config.date) config.date = new Date(Date.now());
		// if no heading, just use the name
		if (!config.title) {
			config.title = name;
		}
		// if url is present use it directly
		// or, if slug is present, use it to generate url, 
		// or create slug first with heading.
		// always ensure there are no two clashing slugs.
		// Handled: url, slug 
		if (!config.url) {
			let slug = config.slug;
			if (!slug) slug = config.title;
			slug = slugify(slug);
			// extract date into path
			// form url yyyy/mm/slug
			let date = config.date;
			let monthStr = getMonthString(date);
			let dateUrl = `${date.getFullYear()}/${monthStr}/${slug}`;
			config.url = dateUrl;
		} else {
			let url = config.url;
			if (url.startsWith("/")) {
				config.url = url.slice(1);
			}
		}
		
        // Make sure name isn't in the published yaml config.
        delete config.name;
        delete config.slug;
        // This is the content that includes both yaml and md.
        config.content = matter.stringify(); 
		// Reset name again.
        config.name = name;
		return config;
	}

	static buildIndexes(contentDirPath, indexDirPath, indexers) {
		const collectFileDataItems = (contentDirPath) => {
			let fileDataItems = [];
			const collector = walkFs(contentDirPath, (f, tasks) => {
				if (!f.stats.isDirectory() &&! f.path.startsWith(indexDirPath)) {
					let filePath = f.path;
					let p = fs.readFile(filePath, "utf-8")
						.then(data => fileDataItems.push(JSON.parse(data)));
					tasks.add(p);
				}
			});
			return collector.then(() => fileDataItems);
		}

		const finalizeIndex = (indexDirPath, indexDescriptors) => {
			let p = indexDescriptors.map(x => {
				let filePath = path.join(indexDirPath, x.name + ".json");
				let data = JSON.stringify(x.data);
				return fs.ensureDir(indexDirPath)
					.then(() =>
						fs.writeFile(filePath, data, { flag: "w+", encoding: "utf-8" }));
			});
			return Promise.all(p);
		}

		return collectFileDataItems(contentDirPath)
			.then((fileDataItems) =>
				_.chain(indexers)
					.map(indexer => indexer(fileDataItems))
					.flatten()
					.value())
			.then((desc) => finalizeIndex(indexDirPath, desc));
	}
}

const RunMode = {
	Build: 0,
	Publish: 1,
}

class Commands {
	static buildAll(srcDir, destDir, forceBuild = false) {
		consoleOut(chalk.cyan("building all published content.."));
		return BuildHelper.processAll(srcDir, destDir, { mode: RunMode.Build, forceBuild })
	}

	static build(src, destDir, forceBuild = false) {
		consoleOut(chalk.cyan(`building ${src}..`));
		return BuildHelper.process(src, destDir, { mode: RunMode.Build, forceBuild })
	}

	static publish(src, destDir) {
		consoleOut(chalk.cyan(`publishing ${src}..`));
		return BuildHelper.process(src, destDir, { mode: RunMode.Publish })
	}

	static publishAll(srcDir, destDir) {
		consoleOut(chalk.cyan("publishing all drafts.."));
		return BuildHelper.processAll(srcDir, destDir, { mode: RunMode.Publish });
	}

	static buildIndexes(srcDir, destDir, indexers) {
		consoleOut(chalk.cyan("building indexes.."));
		return BuildHelper.buildIndexes(srcDir, destDir, indexers);
	}
}


function runAll(opts) {
	consoleOut(chalk.green("start publish and build"));
	Commands.publishAll(opts.draftsDir, opts.publishDir)
		.then(() => Commands.buildAll(opts.publishDir, opts.contentDir, opts.force))
		.then(() => Commands.buildIndexes(opts.contentDir, opts.indexesDir, getIndexers()))
		.then(() => consoleOut(chalk.green("done")));
}

function runBuild(opts) {
	consoleOut(chalk.green("start build"));
	Commands.buildAll(opts.publishDir, opts.contentDir, opts.force)
		.then(() => Commands.buildIndexes(opts.contentDir, opts.indexesDir, getIndexers()))
		.then(() => consoleOut(chalk.green("done")));
}

function runPublish(opts) {
	const sources = opts.files;
	if (!sources || sources.length == 0) {
		consoleOut(chalk.green("publishing all"));
		Commands.publishAll(opts.draftsDir, opts.publishDir)
			.then(() => consoleOut(chalk.green("done")));
	} else {
		sources.forEach(x => {
			let src;
			let p = path.join(process.cwd(), x);
			if (fs.existsSync(p)) {
				src = p;
			} else {
				p = path.join(opts.draftsDir, x);
				if (fs.existsSync(p)) {
					src = p;
				} else {
					console.error(chalk.red("error: " + x + " not found"));
				}
			}
			if (src) {
				consoleOut(chalk.cyan("processing " + x));
				Commands.publish(src, opts.publishDir)
					.then(() => consoleOut(chalk.green("done")));
			}
		});
	}
}

function spread(arg, ...values) {
	return Object.assign({}, arg, ...values);
}

function start() {
	let program = commander;
	let opts = defaultOptions();
	
	program
		.version("1.0.0")
		.option("--verbose", "verbose")
		.option("-d, --drafts-dir [path]", "drafts location", x => path.resolve(x))
		.option("-p, --publish-dir [path]", "publish location", x => path.resolve(x))
		.option("-c, --content-dir [path]", "content location", x => path.resolve(x))
		.option("-i, --indexes-dir [path]", "indexes location", x => path.resolve(x));
	
	program
		.command("publish [files...]")
		.description("publish all drafts or single provided draft")
		.action((files, env) => {
			runPublish(spread(opts, env.parent, files));
		});
	
	program
		.command("build")
		.option("-f, --force", "force build")
		.description("build everything that has already been published")
		.action((env) => {
			runBuild(spread(opts, env.parent, env));
		});
	
	program
		.command("run")
		.option("-f, --force", "force build")		
		.description("publish all drafts, and build all content")
		.action((env) => {
			runAll(spread(opts, env.parent, env));
		});
	
	program.parse(process.argv);

	if (program.args.length < 1) {
		program.help();
	}
}

start();