import React, { PropTypes } from 'react';
import ReactDOM from 'react-dom';
// import escapeStringRegexp from 'escape-string-regexp';
import srcDoc from 'srcdoc-polyfill';

import loopProtect from 'loop-protect';
import { getBlobUrl } from '../actions/files';
import { resolvePathToFile } from '../../../../server/utils/filePath';

const decomment = require('decomment');

const startTag = '@fs-';
// eslint-disable-next-line max-len
const MEDIA_FILE_REGEX = /^('|")(?!(http:\/\/|https:\/\/)).*\.(png|jpg|jpeg|gif|bmp|mp3|wav|aiff|ogg|json|txt|csv|svg|obj|mp4|ogg|webm|mov|otf|ttf|m4a)('|")$/i;
// eslint-disable-next-line max-len
const MEDIA_FILE_REGEX_NO_QUOTES = /^(?!(http:\/\/|https:\/\/)).*\.(png|jpg|jpeg|gif|bmp|mp3|wav|aiff|ogg|json|txt|csv|svg|obj|mp4|ogg|webm|mov|otf|ttf|m4a)$/i;
const STRING_REGEX = /(['"])((\\\1|.)*?)\1/gm;
const TEXT_FILE_REGEX = /(.+\.json$|.+\.txt$|.+\.csv$)/i;
const NOT_EXTERNAL_LINK_REGEX = /^(?!(http:\/\/|https:\/\/))/;
const EXTERNAL_LINK_REGEX = /^(http:\/\/|https:\/\/)/;

function getAllScriptOffsets(htmlFile) {
  const offs = [];
  let found = true;
  let lastInd = 0;
  let ind = 0;
  let endFilenameInd = 0;
  let filename = '';
  let lineOffset = 0;
  while (found) {
    ind = htmlFile.indexOf(startTag, lastInd);
    if (ind === -1) {
      found = false;
    } else {
      endFilenameInd = htmlFile.indexOf('.js', ind + startTag.length + 3);
      filename = htmlFile.substring(ind + startTag.length, endFilenameInd);
      // the length of hijackConsoleErrorsScript is 35 lines, already needed a -1 offset.
      lineOffset = htmlFile.substring(0, ind).split('\n').length + 34;
      offs.push([lineOffset, filename]);
      lastInd = ind + 1;
    }
  }
  return offs;
}

function hijackConsoleErrorsScript(offs) {
  const s = `
    function getScriptOff(line) {
      var offs = ${offs};
      var l = 0;
      var file = '';
      for (var i=0; i<offs.length; i++) {
        var n = offs[i][0];
        if (n < line && n > l) {
          l = n;
          file = offs[i][1];
        }
      }
      return [line - l, file];
    }
    // catch reference errors, via http://stackoverflow.com/a/12747364/2994108
    window.onerror = function (msg, url, lineNumber, columnNo, error) {
        var string = msg.toLowerCase();
        var substring = "script error";
        var data = {};
        if (string.indexOf(substring) !== -1){
          data = 'Script Error: See Browser Console for Detail';
        } else {
          var fileInfo = getScriptOff(lineNumber);
          data = msg + ' (' + fileInfo[1] + ': line ' + fileInfo[0] + ')';
        }
        window.parent.postMessage([{
          method: 'error',
          arguments: data,
          source: fileInfo[1]
        }], '*');
      return false;
    };
  `;
  return s;
}

class PreviewFrame extends React.Component {

  componentDidMount() {
    if (this.props.isPlaying) {
      this.renderFrameContents();
    }

    window.addEventListener('message', (messageEvent) => {
      messageEvent.data.forEach((message) => {
        const args = message.arguments;
        Object.keys(args).forEach((key) => {
          if (args[key].includes('Exiting potential infinite loop')) {
            this.props.stopSketch();
            this.props.expandConsole();
          }
        });
      });
      this.props.dispatchConsoleEvent(messageEvent.data);
    });
  }

  componentDidUpdate(prevProps) {
    // if sketch starts or stops playing, want to rerender
    if (this.props.isPlaying !== prevProps.isPlaying) {
      this.renderSketch();
      return;
    }

    // if the user explicitly clicks on the play button
    if (this.props.isPlaying && this.props.previewIsRefreshing) {
      this.renderSketch();
      return;
    }

    // if user switches textoutput preferences
    if (this.props.isAccessibleOutputPlaying !== prevProps.isAccessibleOutputPlaying) {
      this.renderSketch();
      return;
    }

    if (this.props.textOutput !== prevProps.textOutput) {
      this.renderSketch();
      return;
    }

    if (this.props.gridOutput !== prevProps.gridOutput) {
      this.renderSketch();
      return;
    }

    if (this.props.soundOutput !== prevProps.soundOutput) {
      this.renderSketch();
      return;
    }

    if (this.props.fullView && this.props.files[0].id !== prevProps.files[0].id) {
      this.renderSketch();
    }

    // small bug - if autorefresh is on, and the usr changes files
    // in the sketch, preview will reload
  }

  componentWillUnmount() {
    ReactDOM.unmountComponentAtNode(this.iframeElement.contentDocument.body);
  }

  clearPreview() {
    const doc = this.iframeElement;
    doc.srcDoc = '';
  }

  injectLocalFiles() {
    const htmlFile = this.props.htmlFile.content;
    let scriptOffs = [];

    const resolvedFiles = this.resolveJSAndCSSLinks(this.props.files);

    const parser = new DOMParser();
    const sketchDoc = parser.parseFromString(htmlFile, 'text/html');

    const base = sketchDoc.createElement('base');
    base.href = `${window.location.href}/`;
    sketchDoc.head.appendChild(base);

    this.resolvePathsForElementsWithAttribute('src', sketchDoc, resolvedFiles);
    this.resolvePathsForElementsWithAttribute('href', sketchDoc, resolvedFiles);
    // should also include background, data, poster, but these are used way less often

    this.resolveScripts(sketchDoc, resolvedFiles);
    this.resolveStyles(sketchDoc, resolvedFiles);

    let scriptsToInject = [
      '/loop-protect.min.js',
      '/hijackConsole.js'
    ];
    if (
      this.props.isAccessibleOutputPlaying ||
      ((this.props.textOutput || this.props.gridOutput || this.props.soundOutput) && this.props.isPlaying)) {
      let interceptorScripts = [];
      interceptorScripts = [
        '/p5-interceptor/registry.js',
        '/p5-interceptor/loadData.js',
        '/p5-interceptor/interceptorHelperFunctions.js',
        '/p5-interceptor/baseInterceptor.js',
        '/p5-interceptor/entities/entity.min.js',
        '/p5-interceptor/ntc.min.js'
      ];
      if (!this.props.textOutput && !this.props.gridOutput && !this.props.soundOutput) {
        this.props.setTextOutput(true);
      }
      if (this.props.textOutput) {
        let textInterceptorScripts = [];
        textInterceptorScripts = [
          '/p5-interceptor/textInterceptor/interceptorFunctions.js',
          '/p5-interceptor/textInterceptor/interceptorP5.js'
        ];
        interceptorScripts = interceptorScripts.concat(textInterceptorScripts);
      }
      if (this.props.gridOutput) {
        let gridInterceptorScripts = [];
        gridInterceptorScripts = [
          '/p5-interceptor/gridInterceptor/interceptorFunctions.js',
          '/p5-interceptor/gridInterceptor/interceptorP5.js'
        ];
        interceptorScripts = interceptorScripts.concat(gridInterceptorScripts);
      }
      if (this.props.soundOutput) {
        let soundInterceptorScripts = [];
        soundInterceptorScripts = [
          '/p5-interceptor/soundInterceptor/interceptorP5.js'
        ];
        interceptorScripts = interceptorScripts.concat(soundInterceptorScripts);
      }
      scriptsToInject = scriptsToInject.concat(interceptorScripts);
    }

    scriptsToInject.forEach((scriptToInject) => {
      const script = sketchDoc.createElement('script');
      script.src = scriptToInject;
      sketchDoc.head.appendChild(script);
    });

    const sketchDocString = `<!DOCTYPE HTML>\n${sketchDoc.documentElement.outerHTML}`;
    scriptOffs = getAllScriptOffsets(sketchDocString);
    const consoleErrorsScript = sketchDoc.createElement('script');
    consoleErrorsScript.innerHTML = hijackConsoleErrorsScript(JSON.stringify(scriptOffs));
    // sketchDoc.head.appendChild(consoleErrorsScript);
    sketchDoc.head.insertBefore(consoleErrorsScript, sketchDoc.head.firstElement);

    return `<!DOCTYPE HTML>\n${sketchDoc.documentElement.outerHTML}`;
  }

  resolvePathsForElementsWithAttribute(attr, sketchDoc, files) {
    const elements = sketchDoc.querySelectorAll(`[${attr}]`);
    const elementsArray = Array.prototype.slice.call(elements);
    elementsArray.forEach((element) => {
      if (element.getAttribute(attr).match(MEDIA_FILE_REGEX_NO_QUOTES)) {
        const resolvedFile = resolvePathToFile(element.getAttribute(attr), files);
        if (resolvedFile) {
          element.setAttribute(attr, resolvedFile.url);
        }
      }
    });
  }

  resolveJSAndCSSLinks(files) {
    const newFiles = [];
    files.forEach((file) => {
      const newFile = { ...file };
      if (file.name.match(/.*\.js$/i)) {
        newFile.content = this.resolveJSLinksInString(newFile.content, files);
      } else if (file.name.match(/.*\.css$/i)) {
        newFile.content = this.resolveCSSLinksInString(newFile.content, files);
      }
      newFiles.push(newFile);
    });
    return newFiles;
  }

  resolveJSLinksInString(content, files) {
    let newContent = content;
    let jsFileStrings = content.match(STRING_REGEX);
    jsFileStrings = jsFileStrings || [];
    jsFileStrings.forEach((jsFileString) => {
      if (jsFileString.match(MEDIA_FILE_REGEX)) {
        const filePath = jsFileString.substr(1, jsFileString.length - 2);
        const resolvedFile = resolvePathToFile(filePath, files);
        if (resolvedFile) {
          if (resolvedFile.url) {
            newContent = newContent.replace(filePath, resolvedFile.url);
          } else if (resolvedFile.name.match(TEXT_FILE_REGEX)) {
            // could also pull file from API instead of using bloburl
            const blobURL = getBlobUrl(resolvedFile);
            this.props.setBlobUrl(resolvedFile, blobURL);
            newContent = newContent.replace(filePath, blobURL);
          }
        }
      }
    });
    newContent = decomment(newContent, { ignore: /noprotect/g });
    newContent = loopProtect(newContent);
    return newContent;
  }

  resolveCSSLinksInString(content, files) {
    let newContent = content;
    let cssFileStrings = content.match(STRING_REGEX);
    cssFileStrings = cssFileStrings || [];
    cssFileStrings.forEach((cssFileString) => {
      if (cssFileString.match(MEDIA_FILE_REGEX)) {
        const filePath = cssFileString.substr(1, cssFileString.length - 2);
        const resolvedFile = resolvePathToFile(filePath, files);
        if (resolvedFile) {
          if (resolvedFile.url) {
            newContent = newContent.replace(filePath, resolvedFile.url);
          }
        }
      }
    });
    return newContent;
  }

  resolveScripts(sketchDoc, files) {
    const scriptsInHTML = sketchDoc.getElementsByTagName('script');
    const scriptsInHTMLArray = Array.prototype.slice.call(scriptsInHTML);
    scriptsInHTMLArray.forEach((script) => {
      if (script.getAttribute('src') && script.getAttribute('src').match(NOT_EXTERNAL_LINK_REGEX) !== null) {
        const resolvedFile = resolvePathToFile(script.getAttribute('src'), files);
        if (resolvedFile) {
          if (resolvedFile.url) {
            script.setAttribute('src', resolvedFile.url);
          } else {
            script.setAttribute('data-tag', `${startTag}${resolvedFile.name}`);
            script.removeAttribute('src');
            script.innerHTML = resolvedFile.content; // eslint-disable-line
          }
        }
      } else if (!(script.getAttribute('src') && script.getAttribute('src').match(EXTERNAL_LINK_REGEX)) !== null) {
        script.innerHTML = this.resolveJSLinksInString(script.innerHTML, files); // eslint-disable-line
      }
    });
  }

  resolveStyles(sketchDoc, files) {
    const inlineCSSInHTML = sketchDoc.getElementsByTagName('style');
    const inlineCSSInHTMLArray = Array.prototype.slice.call(inlineCSSInHTML);
    inlineCSSInHTMLArray.forEach((style) => {
      style.innerHTML = this.resolveCSSLinksInString(style.innerHTML, files); // eslint-disable-line
    });

    const cssLinksInHTML = sketchDoc.querySelectorAll('link[rel="stylesheet"]');
    const cssLinksInHTMLArray = Array.prototype.slice.call(cssLinksInHTML);
    cssLinksInHTMLArray.forEach((css) => {
      if (css.getAttribute('href') && css.getAttribute('href').match(NOT_EXTERNAL_LINK_REGEX) !== null) {
        const resolvedFile = resolvePathToFile(css.getAttribute('href'), files);
        if (resolvedFile) {
          if (resolvedFile.url) {
            css.href = resolvedFile.url; // eslint-disable-line
          } else {
            const style = sketchDoc.createElement('style');
            style.innerHTML = `\n${resolvedFile.content}`;
            sketchDoc.head.appendChild(style);
            css.parentElement.removeChild(css);
          }
        }
      }
    });
  }

  renderSketch() {
    const doc = this.iframeElement;
    if (this.props.isPlaying) {
      srcDoc.set(doc, this.injectLocalFiles());
      if (this.props.endSketchRefresh) {
        this.props.endSketchRefresh();
      }
    } else {
      doc.srcdoc = '';
      srcDoc.set(doc, '  ');
    }
  }

  renderFrameContents() {
    const doc = this.iframeElement.contentDocument;
    if (doc.readyState === 'complete') {
      this.renderSketch();
    } else {
      setTimeout(this.renderFrameContents, 0);
    }
  }

  render() {
    return (
      <iframe
        className="preview-frame"
        aria-label="sketch output"
        role="main"
        tabIndex="0"
        frameBorder="0"
        title="sketch output"
        ref={(element) => { this.iframeElement = element; }}
        sandbox="allow-scripts allow-pointer-lock allow-same-origin allow-popups allow-forms"
      />
    );
  }
}

PreviewFrame.propTypes = {
  isPlaying: PropTypes.bool.isRequired,
  isAccessibleOutputPlaying: PropTypes.bool.isRequired,
  textOutput: PropTypes.bool.isRequired,
  gridOutput: PropTypes.bool.isRequired,
  soundOutput: PropTypes.bool.isRequired,
  setTextOutput: PropTypes.func.isRequired,
  htmlFile: PropTypes.shape({
    content: PropTypes.string.isRequired
  }).isRequired,
  files: PropTypes.arrayOf(PropTypes.shape({
    content: PropTypes.string.isRequired,
    name: PropTypes.string.isRequired,
    url: PropTypes.string,
    id: PropTypes.string.isRequired
  })).isRequired,
  dispatchConsoleEvent: PropTypes.func.isRequired,
  endSketchRefresh: PropTypes.func.isRequired,
  previewIsRefreshing: PropTypes.bool.isRequired,
  fullView: PropTypes.bool,
  setBlobUrl: PropTypes.func.isRequired,
  stopSketch: PropTypes.func.isRequired,
  expandConsole: PropTypes.func.isRequired
};

PreviewFrame.defaultProps = {
  fullView: false
};

export default PreviewFrame;
