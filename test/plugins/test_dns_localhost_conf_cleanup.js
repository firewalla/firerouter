/*    Copyright 2016-2026 Firewalla Inc.
 *
 *    This program is free software: you can redistribute it and/or  modify
 *    it under the terms of the GNU Affero General Public License, version 3,
 *    as published by the Free Software Foundation.
 *
 *    This program is distributed in the hope that it will be useful,
 *    but WITHOUT ANY WARRANTY; without even the implied warranty of
 *    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *    GNU Affero General Public License for more details.
 *
 *    You should have received a copy of the GNU Affero General Public License
 *    along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

'use strict'

let chai = require('chai');
let expect = chai.expect;

const DNSPlugin = require('../../plugins/dns/dns_plugin.js');

describe('DNSPlugin._findDeadLocalhostUpstream', function () {
  it('deletes a single-line dead localhost upstream, unflagged', () => {
    const result = DNSPlugin._findDeadLocalhostUpstream('server=127.0.0.1#8953$unbound$*wan\n', false);
    expect(result).to.deep.equal({ port: '8953', mixed: false });
  });

  it('deletes a dead localhost upstream mixed with other directives, flagged as mixed', () => {
    const content = 'server=127.0.0.1#8953$unbound$*wan\nmark=123$foo$*!wan\n';
    const result = DNSPlugin._findDeadLocalhostUpstream(content, false);
    expect(result).to.deep.equal({ port: '8953', mixed: true });
  });

  it('keeps the conf when the upstream is listening, even if mixed with other directives', () => {
    const content = 'server=127.0.0.1#8953$unbound$*wan\nmark=123$foo$*!wan\n';
    const result = DNSPlugin._findDeadLocalhostUpstream(content, true);
    expect(result).to.equal(null);
  });

  it('skips confs with no localhost upstream directive', () => {
    const result = DNSPlugin._findDeadLocalhostUpstream('mark=123$foo$*!wan\n', false);
    expect(result).to.equal(null);
  });
});

describe('DNSPlugin._parseListeningPorts', function () {
  it('detects a port listening on the literal loopback address', () => {
    const ssOutput = 'tcp   LISTEN 0 128  127.0.0.1:8953   0.0.0.0:*\n';
    expect(DNSPlugin._parseListeningPorts(ssOutput).has('8953')).to.equal(true);
  });

  it('detects a port listening on the IPv4 wildcard address', () => {
    const ssOutput = 'tcp   LISTEN 0 128  0.0.0.0:8953   0.0.0.0:*\n';
    expect(DNSPlugin._parseListeningPorts(ssOutput).has('8953')).to.equal(true);
  });

  it('detects a port listening on the IPv6 wildcard address', () => {
    const ssOutput = 'tcp   LISTEN 0 128  [::]:8953   [::]:*\n';
    expect(DNSPlugin._parseListeningPorts(ssOutput).has('8953')).to.equal(true);
  });

  it('does not report a port that is not listening', () => {
    const ssOutput = 'tcp   LISTEN 0 128  0.0.0.0:53   0.0.0.0:*\n';
    expect(DNSPlugin._parseListeningPorts(ssOutput).has('8953')).to.equal(false);
  });
});
