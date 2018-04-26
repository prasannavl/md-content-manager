import _ from "lodash";
import { consoleOut } from "./utils";

export function getIndexers() {
    let indexers = [archivesIndexer, recentIndexer, featuredIndexer];
    return indexers;
}

const allIndexer = (fileDataItems) => {
    consoleOut("all..");

    let indexData = _.chain(fileDataItems)
        .map(x => _.omit(x, "content"))
        .sortBy(x => new Date(x.date))
        .reverse()
        .value();

    return { data: indexData, name: "all" };
};

const recentIndexer = (fileDataItems) => {
    consoleOut("recent..");

    let indexData = _.chain(fileDataItems)
        .map(x => _.omit(x, "content"))
        .sortBy(x => new Date(x.date))
        .takeRight(5)
        .reverse()
        .value();

    return { data: indexData, name: "recent" };
};

const featuredIndexer = (fileDataItems) => {
    consoleOut("featured..");

    let indexData = _.chain(fileDataItems)
        .map(x => _.omit(x, "content"))
        .filter(x => x.featured)
        .sortBy(x => new Date(x.date))
        .takeRight(5)
        .reverse()
        .value();

    return { data: indexData, name: "featured" };
};

const archivesIndexer = (fileDataItems) => {
    consoleOut("archives..");

    let indexData = _.chain(fileDataItems)
        .map(x => _.omit(x, "content"))        
        .sortBy(x => new Date(x.date))
        .reverse()
        .groupBy(x => new Date(x.date).getFullYear())
        .toPairs()
        .reverse()
        .value();

    return { data: indexData, name: "archives" };
};

const tagListIndexer = (fileDataItems) => {
    consoleOut("taglist..");

    let indexData = _.chain(fileDataItems)
        .map(x => x.tags)
        .flatten()
        .uniq()
        .value();

    return { data: indexData, name: "taglist" };
};

const overviewIndexer = (fileDataItems) => {
    consoleOut("overview..");

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
    
    let indexData = _.chain(fileDataItems)
        .filter(x => x.overview !== false)
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