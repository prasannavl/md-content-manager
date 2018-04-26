import fs from "fs-extra";
import walk from "klaw";
import RefCount from "./refcount";
import chalk from "chalk";

export function walkFs(inputDirPath, action, onEndAction) {
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

export function writeFile(inFileNotificationName, destPath, data) {
    return fs.writeFile(destPath, data, { flag: "w+", encoding: "utf-8" })
        .then(() => consoleOut(`${inFileNotificationName} => ${destPath}`))
        .catch(err => consoleOut(`${inFileNotificationName} => ${err}`));
}

export function consoleOut(str) {
	console.log(chalk.gray("content-manager: ") + str);
}

export function getMonthString(date) {
	let monthStr = (date.getMonth() + 1).toString();
	if (monthStr.length === 1) {
		monthStr = "0" + monthStr;
	}
	return monthStr;
}