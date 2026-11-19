// Builds the site's data from an export zip dropped on the page, inside the browser. The zip is read from the
// visitor's disk in pieces and nothing is sent anywhere.
// Receives { file }. Posts { type: 'progress', label, share }, then { type: 'done', summary, intraday, avatar }
// or { type: 'error', message }.
import { build } from './engine/build.js';
import { zipFolder, fileReader, browserPlatform } from './engine/zip-folder.js';

self.onmessage = async ({ data: { file } }) => {
  const progress = (label, share = null) => self.postMessage({ type: 'progress', label, share });
  try {
    progress('Opening the zip');
    const folder = await zipFolder(fileReader(file), browserPlatform, file.name);
    // The build's log lines are for developers; a source finishing is the one step worth naming.
    let readOne = false;
    const log = (...parts) => {
      const read = /^read (.+)$/.exec(parts.join(' '));
      if (read) readOne = true;
      progress(read ? `Read ${read[1]}. Working out the charts` : readOne ? 'Working out the charts' : 'Reading the export');
    };
    const { summary, intraday, avatar } = await build({ folder, platform: browserPlatform, log, progress });
    self.postMessage({ type: 'done', summary, intraday, avatar }, avatar ? [avatar.buffer] : []);
  } catch (err) {
    self.postMessage({ type: 'error', message: err?.message || String(err) });
  }
};
