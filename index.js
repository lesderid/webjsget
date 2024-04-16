// TODO: Keep external sources without sourcemaps
// TODO: Check if deduping works
// TODO: Check if deduping is actually necessary (if not: get rid of lodash)
// TODO: Use eslint
// TODO: Add option to specify out dir
// TODO: Add option to ignore arbitrary paths (e.g. 'node_modules')
// TODO: Add option for arbitrary path substitutions
// TODO: Parse 'webpack/bootstrap' etc. to find more files
// TODO: Make this available as a library

import { parse } from "node-html-parser";
import jsBeautify from "js-beautify";
import prettier from "prettier";
import assert from "node:assert/strict";
import hash from "string-hash";
import _ from "lodash-es";
import fs from "node:fs/promises";
import {join as joinPaths, dirname} from "node:path";

async function getPage(url) {
    const request = await fetch(url);
    const text = await request.text();

    return parse(text);
}

function getScripts(page, rootUrl) {
    const scriptElements = page.getElementsByTagName("script");

    return scriptElements.map(e => {
        const src = e.getAttribute("src")
        if (src) {
            if (!["://", "http://", "https://"].some(p => src.startsWith(p))) {
                return {src: `${new URL(rootUrl).origin}${src}`};
            }
            return {src};
        } else {
            return {innerText: e.innerText};
        }
    });
}

async function prettifyScript({text, path}) {
    const beautified = (!path || path.endsWith('.js')) ? jsBeautify.js(text, {indent_size: 4}) : text;

    const prettify = async (s, p) => await prettier.format(s, p ? {filepath: p} : {parser: "babel"});
    let prettified;
    try {
        prettified = await prettify(beautified, path);
    } catch {
        try {
            prettified = await prettify(text, path);
        } catch {
            try {
                prettified = await prettify(text, `${path}.tsx`);
            } catch (e) {
                console.log({text, path});
                throw e;
            }
        }
    }
    return prettified;
}

function textHash(text) {
    return hash(text).toString(16).padStart(8, '0');
}

function embeddedScriptToSource(text) {
    return {text, path: `./_embedded/${textHash(text)}.js`};
}

async function getSourceMaps({src, text}) {
    const lines = text.split('\n');
    const sourceMapLines = lines.filter(l => l.startsWith('//# sourceMappingURL'));
    const sourceMapUrls = sourceMapLines.map(l => new URL(l.replace('//# sourceMappingURL=', ''), src).toString());
    return Promise.all(sourceMapUrls.map(async url => await (await fetch(url)).json()));
}

function extractSourceMapSources(sourceMap) {
    assert(sourceMap.sources.length === sourceMap.sourcesContent.length);

    const sources = [];

    for (let i = 0; i < sourceMap.sources.length; i++) {
        sources.push({path: sourceMap.sources[i], text: sourceMap.sourcesContent[i]});
    }

    return sources;
}

function cleanSourcePath({path, text}) {
    return {
        text,
        path: path.replace("webpack:///", "")
                  .replace("webpack/bootstrap", "./_webpack/bootstrap.js")
                  .replace("(webpack)/buildin/", "./_webpack/buildin/")
                  .replace(/\$$/, "")
                  .replace(/[\?#].*/, "")
    };
}

function dedupeSources(sources) {
    return _(sources).groupBy("path").values().flatMap(ss => {
        const sortedSources = _.sortBy(ss, s => -s.text.length);
        return [
            sortedSources[0],
            ...sortedSources.splice(1).map(s => ({
                text: s.text,
                path: `${s.path.substr(0, s.path.lastIndexOf('.'))}.@@deduped@@.${textHash(s.text)}.${s.path.substr(s.path.lastIndexOf('.') + 1)}` //TODO: use path.parse + path.format
            }))
        ];
    }).uniqBy(s => s.path).sortBy(s => s.path).value();
}

async function writeSources(sources, baseDir) {
    for (const {path, text} of sources) {
        const fullPath = joinPaths(baseDir, path);
        const dir = dirname(fullPath);

        await fs.mkdir(dir, {recursive: true});
        await fs.writeFile(fullPath, text);
    }
}

async function main() {
    if (process.argv.length != 3) {
        console.error(`usage: yarn start <URL>`);
        process.exit(1);
    }

    const url = process.argv[2];
    const page = await getPage(url);
    const scripts = getScripts(page, url);

    const embeddedScripts = scripts.filter(s => s.innerText);
    const prettyEmbeddedScripts = await Promise.all(embeddedScripts.map(s => ({text: s.innerText})).map(prettifyScript));
    const prettyEmbeddedSources = prettyEmbeddedScripts.map(embeddedScriptToSource);

    const externalScripts = await Promise.all(scripts.filter(s => s.src).map(s => s.src).map(async src => ({src, text: await (await fetch(src)).text()})));
    const sourceMaps = [...new Set((await Promise.all(externalScripts.map(getSourceMaps))).flat())];
    const externalSources = sourceMaps.map(extractSourceMapSources).flat().map(cleanSourcePath);
    const prettyExternalSources = await Promise.all(externalSources.map(async s => ({text: await prettifyScript(s), path: s.path})));

    const sources = [...prettyEmbeddedSources, ...prettyExternalSources];

    const dedupedSources = dedupeSources(sources);

    await writeSources(sources, "./out/");
}

main();
