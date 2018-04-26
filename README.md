# Markdown Content Manager (md-content-manager)

Creates and manages markdown content and converts them into json indices. Works with drafts and publication semantics.

```
  Usage: md-content-manager [options] [command]

  Options:

    -V, --version             output the version number
    --verbose                 verbose
    -d, --drafts-dir [path]   drafts location
    -p, --publish-dir [path]  publish location
    -c, --content-dir [path]  content location
    -i, --indexes-dir [path]  indexes location
    -h, --help                output usage information

  Commands:

    publish [files...]        publish all drafts or single provided draft
    build [options]           build everything that has already been published
    run [options]             publish all drafts, and build all content
```

### Workflow

    - Create file in `drafts` dir.
    - Add an optional yaml front matter to the md file. 
    - Add any of `title`, `date`, `tags`, etc options to front-matter
    - Run `md-content-manager publish [file]` to publish md to `publish` dir.
    - Can also simply publish all files when run without a file.
    - Run `md-content-manager build` to build `md` into `json`, and also build indexes
    - Indexers can be modified using the `getIndexers` functions. 
    - Default indexers include `archives`, `recent`, `featured`, etc. 
