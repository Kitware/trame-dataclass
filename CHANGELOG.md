# CHANGELOG

<!-- version list -->

## v2.0.4 (2026-04-03)

### Bug Fixes

- **version**: Be explicit on which protocol get initialized
  ([`f3cc356`](https://github.com/Kitware/trame-dataclass/commit/f3cc356c07e1698d7e07cbcda1fc18f414774f99))


## v2.0.3 (2026-03-26)

### Bug Fixes

- **ForwardRef**: Better handling for unresolved name
  ([`c1907cc`](https://github.com/Kitware/trame-dataclass/commit/c1907cc5d09de2de84d1fd2157ebc9dc4bc035fe))


## v2.0.2 (2026-03-24)

### Bug Fixes

- **module**: Make v2 the new default
  ([`f9f4bf2`](https://github.com/Kitware/trame-dataclass/commit/f9f4bf228a621371112384f7f6d7e609597e9ee3))


## v2.0.1 (2026-03-20)

### Bug Fixes

- **v1**: Use same class definition for both v1 and v2
  ([`c4dcc14`](https://github.com/Kitware/trame-dataclass/commit/c4dcc142f675a9ff35d965d0ba2f3691778e3d62))

### Continuous Integration

- Prevent release on PR
  ([`f60a0de`](https://github.com/Kitware/trame-dataclass/commit/f60a0de91a3d5f7644727517a5f0f2f5b37694d7))


## v2.0.0 (2026-03-19)

### Continuous Integration

- Update precommit
  ([`7767cce`](https://github.com/Kitware/trame-dataclass/commit/7767cce7db3ba426e18e67dc967f7229c5c6d18a))

### Features

- Dataclass is ready for prime time
  ([`5af6bc9`](https://github.com/Kitware/trame-dataclass/commit/5af6bc974864bb384b034c696d2d0d29819101bd))


## v1.6.2 (2026-03-18)

### Bug Fixes

- **typing**: Improve type checking allowing ForwardRef
  ([`98872ca`](https://github.com/Kitware/trame-dataclass/commit/98872cae4868f2b257f649dd75d26821f93a002b))


## v1.6.1 (2026-03-13)

### Bug Fixes

- **serverState**: Improve cache with circular dep
  ([`3055977`](https://github.com/Kitware/trame-dataclass/commit/30559776e5c7a425672e8f7bf39b734e926dcc32))


## v1.6.0 (2026-03-11)

### Features

- **deepReactive**: Add deepReactive client detection
  ([`0860d6c`](https://github.com/Kitware/trame-dataclass/commit/0860d6c6919243ab06f4ea27039d5c23c6d28489))


## v1.5.3 (2026-03-07)

### Bug Fixes

- **perf**: Prevent sending data back to client
  ([`fbf29b7`](https://github.com/Kitware/trame-dataclass/commit/fbf29b739ff6a2d9736230126c9195cbcde2723a))


## v1.5.2 (2026-03-04)

### Bug Fixes

- **v2**: Remove clone and add copy
  ([`b6d2ced`](https://github.com/Kitware/trame-dataclass/commit/b6d2cedd65f3896e30784bca0fa14d8f00202a3a))

### Continuous Integration

- Update pyproject validation
  ([`bc73fee`](https://github.com/Kitware/trame-dataclass/commit/bc73fee14ebdffadac633f6f16b1f4343d8d12e8))


## v1.5.1 (2026-02-27)

### Bug Fixes

- **get_instance**: Return None with invalid id
  ([`b85a2e1`](https://github.com/Kitware/trame-dataclass/commit/b85a2e18886e3f1729ef8fa3bcb931f450fbf322))


## v1.5.0 (2026-02-26)

### Features

- **v2**: Improve encoding and type checking
  ([`792e244`](https://github.com/Kitware/trame-dataclass/commit/792e244736366dc83839879ac594dcab76c7daec))


## v1.4.5 (2026-02-24)

### Bug Fixes

- **type_checking**: Fix error on sync/client_only
  ([`ea39278`](https://github.com/Kitware/trame-dataclass/commit/ea39278da322fc4fb5dcb2f8ddfb9739500e68b7))


## v1.4.4 (2026-02-24)

### Bug Fixes

- **typing**: Add flexibility in type checking
  ([`4e20c1f`](https://github.com/Kitware/trame-dataclass/commit/4e20c1f0cc3b86d35d4de2e88b3314d739604a76))


## v1.4.3 (2026-02-23)

### Bug Fixes

- **version**: Add version in module to prevent caching
  ([`42012f9`](https://github.com/Kitware/trame-dataclass/commit/42012f94b2f44f9c40152b5f41c539cba73c0f9d))


## v1.4.2 (2026-02-23)

### Bug Fixes

- **js**: Properly handle direct dataclass as field
  ([`1e714ce`](https://github.com/Kitware/trame-dataclass/commit/1e714ce827b5843ef52343eb4da83af262c3ba4f))


## v1.4.1 (2026-02-18)

### Bug Fixes

- **default**: Properly apply defaults in v2
  ([`4c70c6f`](https://github.com/Kitware/trame-dataclass/commit/4c70c6fde22667eed26be5e943086ca7c8e465bd))


## v1.4.0 (2026-02-16)

### Features

- V2 implementation on py side
  ([`70d50b5`](https://github.com/Kitware/trame-dataclass/commit/70d50b585c535a1458b8edf9c9015e2a2f8f2c98))


## v1.3.1 (2025-12-08)

### Bug Fixes

- **clone**: Attach server automatically
  ([`167a6a0`](https://github.com/Kitware/trame-dataclass/commit/167a6a07f313d83de56d701b4431e9477335530f))


## v1.3.0 (2025-10-29)

### Bug Fixes

- **async**: Expose async completion method
  ([`32a1cf6`](https://github.com/Kitware/trame-dataclass/commit/32a1cf683770561783c04de859c5d44e7cad3bab))

- **leak**: Prevent instances to stick around
  ([`1b9ea05`](https://github.com/Kitware/trame-dataclass/commit/1b9ea05a8d4287cbee0ea1677451ea6df85b06b9))

### Continuous Integration

- Increase yield time for windows
  ([`982677e`](https://github.com/Kitware/trame-dataclass/commit/982677ec2a77e13bee99508491b4326216a9dc3c))

- Increase yield time for windows
  ([`3d444de`](https://github.com/Kitware/trame-dataclass/commit/3d444de73a61ac13ddde41e99cb25734f68adb0a))

### Features

- **async**: Provide method to wait for completion
  ([`19482dc`](https://github.com/Kitware/trame-dataclass/commit/19482dc78f8ac1959aa095c9ab32b96d67fd2d7c))


## v1.2.0 (2025-10-09)

### Features

- **decorator**: Add support for kwargs on @watch
  ([`1138a69`](https://github.com/Kitware/trame-dataclass/commit/1138a698c4469578f9a98a81bfb083c49876abc3))


## v1.1.5 (2025-09-17)

### Bug Fixes

- **issubclass**: Guard using isclass
  ([`11b6e26`](https://github.com/Kitware/trame-dataclass/commit/11b6e2619264c857bde284c0ac7bdc85a1202cff))


## v1.1.4 (2025-09-12)

### Bug Fixes

- **js**: Create ref when missing
  ([`44c7764`](https://github.com/Kitware/trame-dataclass/commit/44c77640dc567e2be2104fdcb0953fc4f7dffde4))

### Continuous Integration

- Update semantic-release version
  ([`5c88fbb`](https://github.com/Kitware/trame-dataclass/commit/5c88fbbda463eeb9e13d680c77df3ce72ee27015))

- Update semantic-release version
  ([`be31508`](https://github.com/Kitware/trame-dataclass/commit/be31508a931515918fd1e4431f91909633d69ffa))

- **semantic-release**: Try to prevent error for non-release
  ([`52f765b`](https://github.com/Kitware/trame-dataclass/commit/52f765b2d0e1738bddad76de47f7efc69ad6408f))


## v1.1.3 (2025-09-12)

### Bug Fixes

- A few type issues and rename Provider to `provide_as`
  ([`5df8d4c`](https://github.com/Kitware/trame-dataclass/commit/5df8d4c327ae388ba1ca2b231e1e2dfb5862eac9))

- Raise exception when client-only fields accessed
  ([`3db5d28`](https://github.com/Kitware/trame-dataclass/commit/3db5d28cb3209874228864db12d69ab5525985fd))


## v1.1.2 (2025-09-09)

### Bug Fixes

- Save DataModel instance as _id for client
  ([`c9f03bc`](https://github.com/Kitware/trame-dataclass/commit/c9f03bcf08f1985d5844e7c3b3cf95c0b80f1a2d))


## v1.1.1 (2025-09-09)

### Bug Fixes

- Guard class comparison
  ([`c478401`](https://github.com/Kitware/trame-dataclass/commit/c47840143ec02a94b2b420b728bea3368ce2cb55))


## v1.1.0 (2025-09-09)

### Documentation

- Add testing scenario
  ([`415e88e`](https://github.com/Kitware/trame-dataclass/commit/415e88eb6f78234dff3ca54f8e35a3f742cb42c0))

### Features

- **StateDataModel**: Use base class instead of decorator
  ([`052eee8`](https://github.com/Kitware/trame-dataclass/commit/052eee8588aa069b0bb0f413547a98e4260ddd98))

### Refactoring

- Rename base class to StateDataModel
  ([`8ba6e3d`](https://github.com/Kitware/trame-dataclass/commit/8ba6e3d112c194e5767fb38fab87ff56208a9cb6))

- Use class instead of decorator
  ([`ee243f8`](https://github.com/Kitware/trame-dataclass/commit/ee243f8dd6a762e7c36062a41f916c5547fe0859))


## v1.0.4 (2025-09-05)

### Bug Fixes

- **decorator**: Add @watch method decoration
  ([`f6c255f`](https://github.com/Kitware/trame-dataclass/commit/f6c255f600c48fd131848ce54736f7105252fcfe))


## v1.0.3 (2025-09-05)

### Bug Fixes

- **typing**: With cricular dep
  ([`75f032d`](https://github.com/Kitware/trame-dataclass/commit/75f032d6b65c82eb59a0d361fd56ecefa0f477b6))


## v1.0.2 (2025-09-04)

### Bug Fixes

- **js**: Handle update before object available
  ([`1a6e6c9`](https://github.com/Kitware/trame-dataclass/commit/1a6e6c9fbff9bc5dac99abb271fef2ff75a25357))


## v1.0.1 (2025-09-04)

### Bug Fixes

- Add {name}_available variable in Provider
  ([`9dc25d3`](https://github.com/Kitware/trame-dataclass/commit/9dc25d3f006b6084b1ff596690e62adb6e56fad2))


## v1.0.0 (2025-09-03)

- Initial Release
