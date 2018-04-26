import fs from "fs-extra";
import path from "path";
import yaml from "js-yaml";
import chalk from "chalk";
import MarkdownIt from "markdown-it";
import _ from "lodash";
import os from "os";
import walk from "klaw";
import htmlMinify from "html-minifier";
import commander from "commander";

function consoleOut(str) {
	console.log(chalk.gray("content-manager: ") + str);
}

function getMonthString(date) {
	let monthStr = (date.getMonth() + 1).toString();
	if (monthStr.length === 1) {
		monthStr = "0" + monthStr;
	}
	return monthStr;
}

const markdownItOpts = {
	html: true,        // Enable HTML tags in source
	breaks: false,        // Convert '\n' in paragraphs into <br>
	linkify: true,
}

const htmlMinifyOpts = {
	minifyCSS: true,
	removeComments: true,
}

class BuildHelper {
	static processAll(inputDirPath, outputDirPath, options) {
		if (!fs.existsSync(inputDirPath)) return Promise.reject(`not found: ${inputDirPath}`);

		return BuildHelper.walkFs(inputDirPath, (f, tasks) => {
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
		const isBuildMode = mode === ConfigMode.Build;

		if (verbose) {
			let fileBasePath = path.basename(inputFile);
			consoleOut(`processing ${fileBasePath}..`);
		}

		let configFactory = isBuildMode ? BuildHelper.createBuildConfig : BuildHelper.createPublishConfig;

		return fs.readFile(inputFile, "utf-8")
			.then(data => {
				let basename = path.basename(inputFile, path.extname(inputFile));
				let config = configFactory(basename, data);
				return config;
			}).then(config => {
				let finalizer = isBuildMode ? BuildHelper.finalizeBuild : BuildHelper.finalizePublish;
				return finalizer(config, inputFile, outputDir, options);
			});
	}

	static walkFs(inputDirPath, action, onEndAction) {
		let tasks = new RefCount(1);
		walk(inputDirPath)
			.on("data", f => {
				action(f, tasks);
			})
			.on("end", (files) => {
				onEndAction && onEndAction(files, tasks);
				tasks.removeRef();
			});
		return tasks.done;
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
						.then(() => BuildHelper.writeFile(path.basename(inputFilePath), destPath, data));
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
			.then(() => BuildHelper.writeFile(path.basename(inputFilePath), destPath, data))
			.then(() => fs.remove(inputFilePath));
	}

	static writeFile(inFileNotificationName, destPath, data) {
		return fs.writeFile(destPath, data, { flag: "w+", encoding: "utf-8" })
			.then(() => consoleOut(`${inFileNotificationName} => ${destPath}`))
			.catch(err => consoleOut(`${inFileNotificationName} => ${err}`));
	}

	static createBuildConfig(name, data) {
		let config = Config.createBuildConfigFrom(Config.parseFromMarkdownString(data));
		let markdownContent = Config.createBuildContent(config, data);
		return Object.assign(config, { content: markdownContent });
	}

	static createPublishConfig(name, data) {
		let markd = new MarkdownIt(markdownItOpts);

		let mTokens = markd.parse(data, {});
		let config = Config.parseFromMarkdownTokens(mTokens);

		// setup config
		if (!config.date) config.date = new Date(Date.now());

		// extract heading
		if (!config.title) {
			let headingItem;
			let headingOpenTagIndex = mTokens.findIndex(x => x.tag === "h1");
			if (headingOpenTagIndex > -1) {
				headingItem = mTokens[headingOpenTagIndex + 1];
				if (headingItem && headingItem.children.length == 1) {
					config.title = headingItem.content;
				}
			}
		}

		// if still no heading, just use the name
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
			slug = sanitizeSlug(slug);
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
		config.name = undefined;
		let configText = Config.createYamlMarkdownCommentFrom(Config.createPublishConfigFrom(config));
		// Reset name again.
		config.name = name;

		let optsCommentAdded = false;
		let markdownContent = data.replace(new RegExp(Config.OptionsRegExpPattern, "gm"), (match) => {
			if (!optsCommentAdded) {
				optsCommentAdded = true;
				return configText;
			}
			return "";
		});
		if (!optsCommentAdded) {
			markdownContent = configText + os.EOL + os.EOL + markdownContent;
		}
		return Object.assign(config, { content: markdownContent });
	}

	static buildIndexes(contentDirPath, indexDirPath, indexers) {
		const collectFileDataItems = (contentDirPath) => {
			let fileDataItems = [];
			const collector = BuildHelper.walkFs(contentDirPath, (f, tasks) => {
				if (!f.stats.isDirectory() && !f.path.startsWith(indexDirPath)) {
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

function sanitizeSlug(slug) {
	let res = "";
	const charsAsDash = ["-", " ", ".", "/", "&", "*", "\\", ";", ",", ":", "+", "%", "#", "(", "[", "=", "{", "<", "@"];
	const removeChars = ["!", "@", "\"", "'", "?", ")", "]", "}", ">"];
	let len = slug.length;
	let lastCharIsDash = false;
	for (let i = 0; i < len; i++) {
		let supressDash = false;
		if (lastCharIsDash) {
			supressDash = true;
			lastCharIsDash = false;
		}
		let c = slug[i];
		if (charsAsDash.findIndex(x => x === c) > -1) {
			if (!supressDash) res += "-";
			lastCharIsDash = true;
		}
		else if (removeChars.findIndex(x => x === c) > -1) {
			// Do nothing
		} else {
			res += c;
		}
	}
	return res.toLowerCase();
}

const ConfigMode = {
	Build: 0,
	Publish: 1,
}

class Config {
	// WARNING: Pattern exeption.
	// Set as undefined instead of null to make sure they
	// are skipped during the JSON processing.
	constructor() {
		this.name = undefined;
		this.date = undefined;
		this.title = undefined;
		this.url = undefined;
		this.tags = [];

		this.slug = undefined;
		this.content = undefined;
	}

	static createPublishConfigFrom(config) {
		const o = Object.assign({}, config);
		o.slug = o.content = undefined;
		return o;
	}

	static createBuildConfigFrom(config) {
		const o = Object.assign({}, Config.createPublishConfigFrom(config));
		return o;
	}

	static parseFromMarkdownTokens(tokens, matchIndicesArray = []) {
		// Note: Currently only a single options match is detected.
		let config = new Config();
		let regex = new RegExp(Config.OptionsRegExpPattern);
		tokens
			.filter((node, i) => node.type === "html_block" && regex.test(node.content) && matchIndicesArray.push(i))
			.map(node => regex.exec(node.content)[1])
			.map(x => yaml.safeLoad(x))
			.forEach(x => Object.assign(config, x));
		return config;
	}

	static parseFromMarkdownString(mdString) {
		// Note: Currently only a single options match is detected.	
		let config = new Config();
		let regex = new RegExp(Config.OptionsRegExpPattern, "gm");
		let match = regex.exec(mdString);
		if (!match) return config;
		let optString = match[1];
		let yamlOpts = yaml.safeLoad(optString);
		return Object.assign(config, yamlOpts);
	}

	static createYamlMarkdownCommentFrom(config) {
		const yamlString = yaml.safeDump(config, { skipInvalid: true });
		const configText = "<!--[options]" + yamlString + "-->";
		return configText;
	}

	static createBuildContent(config, contentString) {
		return Config.createBuildContentAsHtml(config, contentString);
	}

	static prepareMarkdownContent(config, contentString) {
		// Clear options from build
		let content = contentString.replace(new RegExp(Config.OptionsRegExpPattern, "gm"), "");
		// Remove any blank lines in the beginning.
		content = content.replace(/^[\s\n\r]*/, "");
		// Remove the heading if present. Its handled by name.
		content = content.replace(new RegExp(`^\\s*#\\s+${config.title.split(" ")[0]}.*\n`, "m"), "");
		return content;
	}

	static createBuildContentAsHtml(config, contentString) {
		let markd = new MarkdownIt(markdownItOpts);
		let html = markd.render(Config.prepareMarkdownContent(config, contentString));
		return htmlMinify.minify(html, htmlMinifyOpts);
	}
}

Config.OptionsRegExpPattern = /^<!--\[options\]\s*\n([\s\S]*)?\n\s*-->/.source;

class RefCount {
	constructor(startRefNumber) {
		this._resolve = null;
		this._promise = new Promise(resolve => this._resolve = resolve);
		this._current = startRefNumber || 0;
	}

	addRef() {
		this._current++;
	}

	removeRef() {
		this._current--;
		if (this._current === 0) {
			this._resolve && this._resolve();
		}
	}

	add(promise) {
		this.addRef();
		promise.then(() => this.removeRef());
	}

	get current() {
		return this._current;
	}

	get done() {
		return this._promise;
	}
}

class Commands {
	static buildAll(srcDir, destDir, forceBuild = false) {
		consoleOut(chalk.cyan("building all published content.."));
		return BuildHelper.processAll(srcDir, destDir, { mode: ConfigMode.Build, forceBuild })
	}

	static build(src, destDir, forceBuild = false) {
		consoleOut(chalk.cyan(`building ${src}..`));
		return BuildHelper.process(src, destDir, { mode: ConfigMode.Build, forceBuild })
	}

	static publish(src, destDir) {
		consoleOut(chalk.cyan(`publishing ${src}..`));
		return BuildHelper.process(src, destDir, { mode: ConfigMode.Publish })
	}

	static publishAll(srcDir, destDir) {
		consoleOut(chalk.cyan("publishing all drafts.."));
		return BuildHelper.processAll(srcDir, destDir, { mode: ConfigMode.Publish });
	}

	static buildIndexes(srcDir, destDir, indexers) {
		consoleOut(chalk.cyan("building indexes.."));
		return BuildHelper.buildIndexes(srcDir, destDir, indexers);
	}
}

function stripStaticPattern(content, pattern) {
	let regex = new RegExp(pattern, "g");
	let match = regex.exec(content);
	let open = 0;
	let openToggle = true;
	while (match != null) {
		if (openToggle) open++; else open--;
		openToggle = !openToggle;
		match = regex.exec(content);
	}
	while (open > 0) {
		content = content.slice(0, content.lastIndexOf(pattern));
		open--;
	}
	return content;
}

function getIndexers() {
	const overviewIndexer = (fileDataItems) => {
		consoleOut("overview..");

		let indexData = _.chain(fileDataItems)
			.filter(x => x.overviewShown !== false)
			.sortBy(x => new Date(x.date))
			.reverse()
			.take(100)
			.map(x => {
				if (x.content.length > 1000) {
					let content = x.content;
					let startIndex = 0;
					let endIndex = 1000;
					let summaryRegEx = /<!--summary-(start|end)-->/g;
					let match;
					while (match = summaryRegEx.exec(content)) { // eslint-disable-line
						let c = match[1];
						if (c === "end") {
							endIndex = match.index;
							break;
						} else if (c === "start") {
							startIndex = match.index + 20;
						}
					}
					content = x.content.slice(startIndex, endIndex);
					content = stripStaticPattern(content, "```");
					content = content.replace(/\s+$/, "");
					return Object.assign({}, x, { content: content + " ..." });
				}
				return x;
			})
			.value();

		return { data: indexData, name: "overview" };
	};

	const archivesIndexer = (fileDataItems) => {
		consoleOut("archives..");

		let indexData = _.chain(fileDataItems)
			.sortBy(x => new Date(x.date))
			.map(x => _.omit(x, "content"))
			.groupBy(x => new Date(x.date).getFullYear())
			.value();

		return { data: indexData, name: "archives" };
	};

	const allIndexer = (fileDataItems) => {
		consoleOut("all..");

		let indexData = _.chain(fileDataItems)
			.map(x => _.omit(x, "content"))
			.sortBy(x => new Date(x.date))
			.reverse()
			.value();

		return { data: indexData, name: "all" };
	};

	let indexers = [overviewIndexer, archivesIndexer, allIndexer];
	return indexers;
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

function defaultOpts() {
	const draftsDir = path.join(__dirname, "./drafts");
	const publishDir = path.join(__dirname, "./published");
	const contentDir = path.join(__dirname, "./content");
	const indexesDir = path.join(contentDir, "./indexes");
	return { draftsDir, contentDir, indexesDir, publishDir };
}

function spread(arg, ...values) {
	return Object.assign({}, arg, ...values);
}

function start() {
	let program = commander;
	let opts = defaultOpts();

	program
		.version("1.0.0")
		.option("--verbose", "verbose")
		.option("-d, --drafts-dir [path]", "drafts location", x => path.resolve(x), opts.draftsDir)
		.option("-p, --publish-dir [path]", "publish location", x => path.resolve(x), opts.publishDir)
		.option("-c, --content-dir [path]", "content location", x => path.resolve(x), opts.contentDir)
		.option("-i, --indexes-dir [path]", "indexes location", x => path.resolve(x), opts.indexesDir);

	program
		.command("publish [files...]")
		.description("publish all drafts or single provided draft")
		.action((files, env) => {
			runPublish(spread(env.parent, files));
		});

	program
		.command("build")
		.option("-f, --force", "force build")
		.description("build everything that has already been published")
		.action((env) => {
			runBuild(spread(env.parent, env));
		});

	program
		.command("run")
		.option("-f, --force", "force build")
		.description("publish all drafts, and build all content")
		.action((env) => {
			runAll(spread(env.parent, env));
		});

	program.parse(process.argv);

	if (program.args.length < 1) {
		program.help();
	}
}

start();