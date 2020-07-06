/* @flow */

import React, { Component } from 'react';
import {observer} from 'mobx-react';

import CodeMirror from './CodeMirror';

import FakeConsole from './FakeConsole';

import Compiler from '../Compiler';

import fixtures from 'babel-plugin-flow-runtime/fixtures.json';

type Props = {};

const defaultExample = `

type Thing = {
  id: string | number;
  name: string;
};

const widget: Thing = {
  id: false,
  name: 'Widget'
};

console.log(widget);
`.trim();

@observer
export default class TryPage extends Component<Props, void> {

  compiler: Compiler;

  handleChange = (code: string) => {
    this.compiler.updateCode(code);
  };

  handleSelectExample = (e: SyntheticEvent) => {
    this.compiler.updateCode((e.target: any).value);
  };

  runCode = () => {
    this.compiler.run();
  };

  handleClickAssertions = () => {
    this.compiler.shouldAssert = !this.compiler.shouldAssert;
    if (this.compiler.shouldAssert) {
      this.compiler.shouldWarn = false;
    }
    this.compiler.updateCode(this.compiler.code);
  };

  handleClickWarnings = () => {
    this.compiler.shouldWarn = !this.compiler.shouldWarn;
    if (this.compiler.shouldWarn) {
      this.compiler.shouldAssert = false;
    }
    this.compiler.updateCode(this.compiler.code);
  };


  handleClickAnnotation = () => {
    this.compiler.shouldAnnotate = !this.compiler.shouldAnnotate;
    this.compiler.updateCode(this.compiler.code);
  };

  constructor (props: Props) {
    super(props);
    this.compiler = new Compiler(defaultExample, 'try');
  }


  render () {
    const compiler = this.compiler;
    return (
      <div className="container-fluid">
        <div className="row bg-faded">
          <div className="col-sm-6 no-gutter">
            {this.renderSelect()}
          </div>
          <div className="col-sm-6 no-gutter">
            <div className="btn-group">
              <button className="btn btn-secondary" onClick={this.handleClickAssertions}>
                {compiler.shouldAssert ? 'Disable Assertions' : 'Enable Assertions'}
              </button>
              <button className="btn btn-secondary" onClick={this.handleClickWarnings}>
                {compiler.shouldWarn ? 'Disable Warnings' : 'Enable Warnings'}
              </button>
              <button className="btn btn-secondary" onClick={this.handleClickAnnotation}>
                {compiler.shouldAnnotate ? 'Disable Annotations' : 'Enable Annotations'}
              </button>
              <button className="btn btn-primary" onClick={this.runCode} disabled={!compiler.isReady}>
                {!compiler.isReady && <i className="fas fa-spinner fa-pulse" />}
                {!compiler.isReady ? ' Starting compiler...' : 'Run'}
              </button>
            </div>
          </div>
        </div>
        <div className="row">
          <div className="col-sm-6 no-gutter">
            <CodeMirror value={compiler.code} onChange={this.handleChange} />
          </div>
          <div className="col-sm-6 no-gutter">
            <hr className="hidden-sm-up" />
            <CodeMirror value={compiler.transformed} readOnly />
            <br />
            <FakeConsole compiler={compiler} style={{
              position: 'fixed',
              bottom: 0,
              width: '80%',
              maxHeight: '70%',
              overflow: 'auto',
              left: 'calc(20% / 2)',
              zIndex: 99999
            }}/>
          </div>
        </div>
      </div>
    );
  }

  renderSelect () {
    return (
      <select onChange={this.handleSelectExample} className="form-control">
        <option value={defaultExample}>Examples</option>
        {fixtures.map(([name, content], index) => {
          return (
            <option key={name} value={content}>{name}</option>
          );
        })}
      </select>
    );
  }
}
