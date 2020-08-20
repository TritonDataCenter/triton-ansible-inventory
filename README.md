<!-- This Source Code Form is subject to the terms of the Mozilla Public
   - License, v. 2.0. If a copy of the MPL was not distributed with this
   - file, You can obtain one at https://mozilla.org/MPL/2.0/. -->

<!--
   - Copyright 2020 Joyent, Inc.
   -->

# triton-ansible-inventory

This is an [Ansible][ansible] inventory plugin for [Triton][triton].

[ansible]: https://docs.ansible.com/
[triton]: https://joyent.com/triton/

## Installing

You can either `git clone` this repo, or `npm install` it to your ansible
directory.

    git clone https://github.com/joyent/triton-ansible-inventory

or

    npm install triton-ansible-inventory

Or if you prefer, you can just download the `triton-ansible-inventory.js` script
right out of this repo and put it in your ansible directory.

## Configuration

By default, the `triton-ansible-inventory` plug-in will use your existing
[`node-triton`][node-triton] configuration. This means it will use your
currently set triton profile, and you need to use `triton profile set [name]`
to change profiles. If your profile is `env`, then `TRITON_*` or `SDC_*`
environment variables will be used.

Alternatively, you can have a `.triton` config directory local to your ansible
directory with a specific profile that you do not wish to change.

[node-triton]: https://github.com/joyent/node-triton

## Usage

You can either specify the inventory plugin on the command line, or configure it
directly in your Ansible config.

### Command Line Usage

Specify the inventory command with the `-i` flag. This example assumes you used
`npm` to install this plugin

    ansible-inventory -i node_modules/.bin/triton-ansible-inventory --list

### Ansible Configuration

You can also add the plugin directly to your ansible config, thereby eliminating
the need to use the `-i` flag.

    [defaults]
    inventory = node_modules/.bin/triton-ansible-inventory

<!-- -->

    ansible-inventory --list
