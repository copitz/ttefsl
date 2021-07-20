const AbstractReader = require('./Abstract');
const spawn = require('child_process').spawn;

/**
 * Read entries from windows system log
 *
 * @type {WindowsReader}
 */
module.exports = class WindowsReader extends AbstractReader {
  /**
   * Add options to the command
   */
  configureCommand() {
    const list = (l) => l.split(',').map(s => parseInt(s.trim()));
    this.command.option('--start-ids <ids>', 'Event IDs for system start', list, [1, 12]);
    this.command.option('--stop-ids <ids>', 'Event IDs for system stop', list, [107, 13]);
  }

  /**
   * Configure this instance (after argv was parsed)
   */
  configure() {
    super.configure();
    this.startIds = this.command.startIds;
    this.stopIds = this.command.stopIds;
  }

  /**
   * Spawn the wevtutil command
   *
   * @return {ChildProcess}
   */
  spawnWindowsEventUtil() {
    const ids = [].concat(this.startIds).concat(this.stopIds);

    const where =
      '*[' +
        'System[' +
          // '(' + ids.map(id => 'EventID=' + id).join(' or ') + ') ' +
          // 'and ' +
            'TimeCreated[' +
                '@SystemTime>=\'' + this.from.toJSON() + '\' ' +
              'and ' +
                '@SystemTime<=\'' + this.to.toJSON() + '\'' +
            ']' +
        ']' +
      ']';
	  
    const args = ['qe', 'System', '/f:Text', '/q:"' + where + '"'];

    // console.log('wevtutil ' + args.join(' '));
    return spawn('wevtutil', args, {shell: true});
  }

  /**
   * Read output from wevtutil child process
   *
   * @param {stream.Readable} output
   * @param {function} eventCallback
   */
  readEvents(output, eventCallback) {
    let index = 0;
    let nextLinesMatter = false;
    let previousLine;
    let currentLine = '';
    let current = { id: undefined, date: undefined };
    output.on('data', (data) => {
      const chunk = (data + '').replace(/\r/g, '');
      for (let i = 0; i < chunk.length; i++) {
        if (chunk[i] !== '\n') {
          currentLine += chunk[i];
        } else {
          if (currentLine === '  Log Name: System' && previousLine === 'Event[' + index + ']:') {
            index++;
            nextLinesMatter = true;
          } else if (nextLinesMatter) {
            if (currentLine.substr(0, 8) === '  Date: ') {
              current.date = new Date(currentLine.substr(8));
            } else if (currentLine.substr(0, 12) === '  Event ID: ') {
              current.id = parseInt(currentLine.substr(12));
            }
            if (current.date && current.id) {
              eventCallback(current);
              current = { id: undefined, date: undefined };
              nextLinesMatter = false;
            }
          }
          previousLine = currentLine;
          currentLine = '';
        }
      }
    })
  }

  /**
   * Spawn wevtutil child process and read entries from it
   *
   * @return {Promise}
   */
  read() {
    return new Promise((resolve) => {
      const eventUtil = this.spawnWindowsEventUtil();

      let startEvent;
      let lastEvent;
      const events = [];
      this.readEvents(eventUtil.stdout, (event) => {
        if (!startEvent || this.startIds.indexOf(event.id) > -1) {
          if (startEvent && lastEvent) {
            events.push({ from: startEvent.date, to: lastEvent.date });
            startEvent = lastEvent = undefined;
          }
          if (!startEvent) {
            startEvent = event;
          }
        } else if (startEvent && this.stopIds.indexOf(event.id) > -1) {
          events.push({ from: startEvent.date, to: event.date });
          startEvent = lastEvent = undefined;
        } else if (startEvent) {
          lastEvent = event;
        }
      });

      eventUtil.stderr.on('data', (data) => {
        console.error(data + '');
      });
      eventUtil.on('close', (code) => {
        if (code !== 0) {
          throw new Error('Windows event util failed');
        } else {
          resolve(events);
        }
      });
    });
  }
};
