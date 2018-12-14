/// This is the main entry point for the schema generation.

const fs = require("fs-extra");
const YAML = require('yamljs');

// Two-try request function.
const req = (function(req) {
  return url => req(url).catch(() => req(url));
})(require("request-promise-native"));

const process = require('process');
const childProcess = require('child-process-es6-promise')
const { JSDOM } = require("jsdom");

require('./arrayFill');

const Endpoint = require('./endpoint');
const Region = require('./region');

const openapi_300 = require('./openapi-3.0.0');
const swaggerspec_20 = require('./swaggerspec-2.0');
const specs = [ openapi_300, swaggerspec_20 ];

const BASE_URL = 'https://developer.riotgames.com/';
const OUTPUT = 'out';


async function cleanupOutput() {
  // Make output folder.
  await fs.mkdirs(OUTPUT);
  let files = await fs.readdir(OUTPUT);
  // Remove any existing output files.
  await Promise.all(files
    .filter(file => !file.startsWith('.'))
    .map(file => fs.remove(OUTPUT + '/' + file)));
  // Copy swagger tool into output.
  await fs.copy('swagger-ui-dist/', OUTPUT + '/tool');
}


async function getEndpoints() {
  // Read endpoints index page.
  let endpointsPageDom = new JSDOM(await req(BASE_URL + 'api-methods/'));
  let endpointsElements = Array.from(
    endpointsPageDom.window.document.getElementsByClassName('api_option'));
  // Create endpoint objects.
  let endpoints = await Promise.all(endpointsElements.map(async endpointElement => {
    // For each endpoint, get its detail page and parse it.
    let name = endpointElement.getAttribute('api-name');
    let desc = endpointElement.getElementsByClassName('api_desc')[0]
      .textContent.trim();
    let endpointDetailJson = await req(BASE_URL + 'api-details/' + name);
    let endpointPageDom = new JSDOM(JSON.parse(endpointDetailJson).html);
    return new Endpoint(endpointPageDom, desc);
  }));

  // Look back at previous version for any missing dtos.
  // TODO: doesn't check if added dtos in turn have their own missing dtos...
  let missingDtos = endpoints.flatMap(endpoint => endpoint.list_missing_dtos()
    .map(dtoName => ({ endpoint, dtoName })));
  if (missingDtos.length) {
    console.log();
    try {
      // Read old openapi json via process call to git.
      let { stdout, stderr } = await childProcess
        .exec('git --no-pager show origin/gh-pages:openapi-3.0.0.min.json');
      if (stderr)
        throw Error(stderr);

      let oldSchema = JSON.parse(stdout);
      for (let { endpoint, dtoName } of missingDtos) {
        // TODO: fullDtoName magic string.
        let fullDtoName = endpoint.name + '.' + dtoName;
        console.log('Missing DTO: ' + fullDtoName + '.');

        let oldDto = oldSchema.components.schemas[fullDtoName]
        if (oldDto) {
          console.log('  Using previous commit version.');
          endpoint.add_old_dto(oldDto);
        }
        else
          console.log('  FAILED to find dto for ' + fullDtoName + '.');
      }
    }
    catch(e) {
      console.log('FAILED to get previous commit.', e);
    }
  }
  return endpoints;
}


async function getRegions() {
  let regionsDom = new JSDOM(await req(BASE_URL + 'regional-endpoints.html'));
  let panel = regionsDom.window.document
    .getElementsByClassName('panel-content')[0];
  let [ serviceTable, ] = panel.getElementsByTagName('table');
  let service = Array.from(serviceTable.tBodies[0].children)
    .map(tableRow => new Region(tableRow));
  return { service };
}


async function writeOutput(endpoints, regions) {
  let data = { endpoints, regions };

  let names = specs.flatMap(s => [
    s.name + '.json',
    s.name + '.min.json',
    s.name + '.yml',
    s.name + '.min.yml'
  ]);
  data.description = `
OpenAPI/Swagger version of the [Riot API](https://developer.riotgames.com/). Automatically generated daily.
## Download OpenAPI Spec File
The following versions of the Riot API spec file are available:
${names.map(n => `- \`${n}\` ([download file](../${n}), [view ui](?${n}))`).join('\n')}
## Source Code
Source code on [GitHub](https://github.com/MingweiSamuel/riotapi-schema). Pull requests welcome!
## Automatically Generated
Rebuilt on [Travis CI](https://travis-ci.org/MingweiSamuel/riotapi-schema/builds) daily.
***
`;

  // Write specs.
  await Promise.all(specs.map(spec => {
    let out = spec.toSpec(data);
    return Promise.all([
      fs.writeFile(spec.name + ".json", JSON.stringify(out, null, 2)),
      fs.writeFile(spec.name + ".min.json", JSON.stringify(out)),
      fs.writeFile(spec.name + ".yml", YAML.stringify(out, 1/0, 2)),
      fs.writeFile(spec.name + ".min.yml", YAML.stringify(out, 0))
    ]);
  }));
}

module.exports = async function(rootDir) {
  process.chdir(rootDir);

  // Cleanup output folder.
  await cleanupOutput();

  process.chdir(rootDir + '/' + OUTPUT);

  // Get endpoints.
  // Get regions.
  let [ endpoints, regions ] = await Promise.all([
    getEndpoints(),
    getRegions()
  ]);

  // Write output spec files.
  await writeOutput(endpoints, regions);
};
