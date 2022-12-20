#!/usr/bin/env node

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/*
 * Copyright 2021, Joyent, Inc.
 * Copyright 2022, MNX Cloud, Inc.
 */

// Modules
var fs = require('fs');
var path = require('path');
var process = require('process');

var bunyan = require('bunyan');
var dashdash = require('dashdash');
var triton = require('triton');
var vasync = require('vasync');

var mod_config = require('triton/lib/config');
var configDir = '~/.triton';

// Objects
var log = bunyan.createLogger({
    name: 'ansible-inventory',
    streams: [
        {
            stream: process.stderr,
            level: process.env.LLEVEL || 'info',
        }
    ],
    src: true,
    serializers: bunyan.stdSerializers
});

if (fs.existsSync(path.join(process.cwd(), '.triton/config.json'))) {
    log.debug('using local config in' + path.join(process.cwd(), '.triton'));
    configDir = path.join(process.cwd(), '.triton');
}

var loadConfig = function loadConfig() {
    // var _config = mod_config.loadConfig({
    //     configDir: configDir
    // });
    var _profiles = mod_config.loadAllProfiles({
        configDir: configDir,
        log: log
    });
    return _profiles;
};

var config = loadConfig();
log.debug({c: config}, 'the config');

/*
 * Ansible inventory scripts must accept two options
 */
var OPTIONS = [
    {
        names: ['list'],
        type: 'bool',
        help: 'Output all hosts info, works as inventory script.'
    },
    {
        names: ['host'],
        type: 'string',
        help: 'Output specific host info, works as inventory script.',
        helpArg: 'HOST'
    },
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Print this help and exit.'
    }
];

var parser = dashdash.createParser({options: OPTIONS});

var ansible_inventory = {
    _meta: {
        hostvars: {}
    },
    all: {
        children: []
    }
};

// Functions


var tritonListMachines = function(c, next) {
    var bastion = {};
    log.debug({this: c}, 'Current profile');
    if (c.name == 'env') {
        log.debug({profile: c}, ('skipping profile env'));
        return next();
    }
    c.keyId = process.env.ANSIBLE_TRITON_KEY_ID || c.keyId;
    triton.createClient({
        log: log,
        configDir: configDir,
        profile: c
    }, function createdClient(err, client) {
        if (err) {
            console.error('error creating Triton client: %s\n%s', err, err.stack);
            process.exitStatus = 1;
            return;
        }

        log.debug({client: client}, 'Triton client object');

        client.cloudapi.listMachines(function handleListMachines(lmerr, insts) {
            var listImgOpts = {
                state: 'all',
                useCache: true
            };
            if (lmerr) {
                log.error({url: c.url, err: err}, 'Not able to list machines');
                next(lmerr);
                return;
            }

            client.listImages(listImgOpts, function handleListImages(lierr) {
                if (lierr) {
                    log.debug(lierr, 'Error retreiving image information');
                }

                log.debug('need to do ' + insts.length);
                var how_many = 0;

                vasync.forEachPipeline({
                    func: function addToInventory(inst, cb) {
                        var getOpts = {
                            useCache: true,
                            name: inst.image
                        };
                        client.getImage(getOpts, function(gierr, image) {
                            log.debug({inst: inst.id, count: ++how_many});
                            var groups = [];
                            var jumpUser = 'root@';
                            ansible_inventory._meta.hostvars[inst.name] = {
                                ansible_host: inst.primaryIp
                            };
                            if (gierr) {
                                log.debug({inst: inst, err: gierr}, 'Error getting image detail');
                            } else {
                                if (image.os === 'windows') {
                                    // Don't inventory windows
                                    cb ();
                                    return;
                                }
                                if (Object.prototype.hasOwnProperty.call(image, 'tags') &&
                                    Object.prototype.hasOwnProperty.call(image.tags, 'default_user')) {
                                    ansible_inventory._meta.hostvars[inst.name].ansible_user = image.tags.default_user;
                                }
                                groups.push(image.os);
                            }
                            // triton.cns.services is comma separated
                            if (Object.prototype.hasOwnProperty.call(inst.tags, 'triton.cns.services')) {
                                inst.tags['triton.cns.services'].split(',').forEach(function (t) {
                                    // Discard port information
                                    groups.push(t.split(':')[0]);
                                });
                            }
                            Object.keys(inst.tags).forEach(function (t) {
                                if (inst.tags[t] === true) {
                                    groups.push(t);
                                }
                            });
                            groups.push(client.profile.name);
                            groups.forEach(function (g) {
                                g = g.replace(/[.-]/g,'_');
                                if (!Object.prototype.hasOwnProperty.call(ansible_inventory, g)) {
                                    ansible_inventory[g] = {hosts: []};
                                }
                                if ( ansible_inventory.all.children.indexOf(g) === -1) {
                                    ansible_inventory.all.children.push(g);
                                }
                                ansible_inventory[g].hosts.push(inst.name);
                            });
                            if (Object.prototype.hasOwnProperty.call(inst.tags, 'tritoncli.ssh.user')) {
                                jumpUser = inst.tags['triton.cli.ssh.user'] + '@';
                            }

                            if (Object.prototype.hasOwnProperty.call(inst.tags, 'tritoncli.ssh.ip')) {
                                ansible_inventory._meta.hostvars[inst.name].ansible_ssh_extra_args =
                                    '-J ' + jumpUser + inst.tags['tritoncli.ssh.ip'];
                                cb();
                                return;
                            } else if (Object.prototype.hasOwnProperty.call(inst.tags, 'tritoncli.ssh.proxy')) {
                                // Need to get the ProxyJump info
                                log.debug({inst: inst.name, proxy: inst.tags['tritoncli.ssh.proxy']}, 'Proxy specified');
                                var proxy_name = inst.tags['tritoncli.ssh.proxy'];
                                // If we already have it cached use that.
                                if (bastion[proxy_name]) {
                                    log.debug({proxy: bastion[proxy_name]}, 'Use cached IP');
                                    ansible_inventory._meta.hostvars[inst.name].ansible_ssh_extra_args =
                                        '-J ' + jumpUser + bastion[proxy_name];
                                    cb();
                                    return;
                                } else {
                                    // Haven't discovered this bastion's IP yet.
                                    log.debug('proxy not cached, retrieving...');
                                    client.getInstance(inst.tags['tritoncli.ssh.proxy'],
                                        function (gmerr, proxy) {
                                            if (gmerr) {
                                            // The instance is configured to use a bastion that doesn't exist
                                                log.debug({inst: inst, err: gmerr},
                                                    'bastion not found');
                                                cb(gmerr);
                                            } else {
                                                log.debug({proxy: proxy}, 'found proxy');
                                                bastion[proxy.name] = proxy.primaryIp;
                                                ansible_inventory._meta.hostvars[inst.name].ansible_ssh_extra_args =
                                                    '-J ' + jumpUser + bastion[proxy_name];
                                                cb();
                                                return;
                                            }
                                        });
                                }
                            } else {
                                log.debug('no proxy configured');
                                cb();
                                return;
                            }
                        });
                    },
                    inputs: insts
                }, function (plerr, res) {
                    if (plerr) {
                        log.error({err: plerr});
                    }
                    log.debug(res);
                    client.close();
                    next(err, insts.length);
                    return;
                });
            });
        });
    });
};

var do_help = function(v) {
    var help = parser.help({includeEnv: true}).trimRight();
    console.log('usage: triton-ansible-inventory [--list|--host=HOST]\n'
                + 'options:\n'
                + help);
    process.exit(v);
};

var do_host = function () {
    /*
     * Although ansible inventory plugins are required to support both --list
     * and --host, --host is only used if `_meta` doesn't exist. Since we always
     * provide _meta, let's be lazy and not implement --host.
     */
    log.error({
        argc: process.argc,
        argv: process.argv
    }, 'I got called with --host');
    process.exit(1);
};

var do_list = function (cfg) {
    log.debug({config: cfg});
    vasync.forEachPipeline({
        func: tritonListMachines,
        inputs: cfg
    }, function (err, r) {
        if (err) { log.debug({err: err}); }
        console.log(JSON.stringify(ansible_inventory));
        log.debug(r);
    });
};

// main
try {
    var opts = parser.parse(process.argv);
} catch (e) {
    console.error('foo: error: %s', e.message);
    process.exit(1);
}

log.debug({opts: opts});

if (opts.help) {
    // If help was requested, print help and exit clean
    do_help(0);
}

if (opts.list && opts.host) {
    console.log('Only one of  --list or --host is allowed');
    do_help(1);
}

if (opts.list) {
    do_list(config);
}

if (opts.host) {
    do_host();
}
