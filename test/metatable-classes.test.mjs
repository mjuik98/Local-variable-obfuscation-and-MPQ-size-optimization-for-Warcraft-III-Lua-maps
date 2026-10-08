import test from 'node:test';
import assert from 'node:assert/strict';
import fengari from 'fengari';
import { protectMap } from '../src/protect.mjs';
import { openMap } from '../src/mpq.mjs';
import { resolveSettings } from '../src/presets.mjs';
import { createLuaMap } from './map-fixture.mjs';

function luaResult(code) {
    const { lua, lauxlib, lualib, to_luastring, to_jsstring } = fengari;
    const state = lauxlib.luaL_newstate();
    try {
        lualib.luaL_openlibs(state);
        const status = lauxlib.luaL_dostring(state, to_luastring(code + '\nreturn main()'));
        assert.equal(status, lua.LUA_OK, status === lua.LUA_OK ? undefined : to_jsstring(lua.lua_tostring(state, -1)));
        return Array.from({ length: lua.lua_gettop(state) }, (_, index) => Buffer.from(lua.lua_tolstring(state, index + 1)).toString());
    } finally { lua.lua_close(state); }
}

// Prototype classes: __index chains, inherited constructors, static fields
// reached through a metatable, string-keyed members and callbacks stored by name.
const PROTOTYPE_CLASSES = `
local function __TS__Class()
    local c = {prototype = {}}
    c.prototype.__index = c.prototype
    c.prototype.constructor = c
    return c
end
local function __TS__ClassExtends(target, base)
    target.____super = base
    local staticMetatable = setmetatable({__index = base}, base)
    setmetatable(target, staticMetatable)
    local baseMetatable = getmetatable(base)
    if baseMetatable and type(baseMetatable.__index) == "function" then staticMetatable.__index = baseMetatable.__index end
    setmetatable(target.prototype, base.prototype)
end
local function __TS__New(target, ...)
    local instance = setmetatable({}, target.prototype)
    instance:____constructor(...)
    return instance
end
local ____exports = {}
____exports.Unit = __TS__Class()
local Unit = ____exports.Unit
Unit.name = "Unit"
function Unit.prototype.____constructor(self, hp)
    self.hp = hp
    self["armor"] = 2
end
function Unit.prototype.damage(self, amount)
    self.hp = self.hp - math.max(0, amount - self.armor)
    return self.hp
end
Unit.count = 0
____exports.Hero = __TS__Class()
local Hero = ____exports.Hero
Hero.name = "Hero"
__TS__ClassExtends(Hero, Unit)
function Hero.prototype.____constructor(self, hp, level)
    Unit.prototype.____constructor(self, hp)
    self.level = level
end
function Hero.prototype.damage(self, amount)
    return Unit.prototype.damage(self, amount // self.level)
end
local registry = {}
local function register(key, value) registry[key] = value end
register("Unit", Unit)
register("Hero", Hero)
local Events = {handlers = {}}
function Events.on(name, fn) Events.handlers[name] = fn end
function Events.fire(name, ...) local h = Events.handlers[name]; if h then return h(...) end end
Events.on("hit", function(u, n) return u:damage(n) end)
function config() end
function main()
    local h = __TS__New(registry.Hero, 100, 2)
    local u = __TS__New(Unit, 50)
    local key = "dam" .. "age"
    return h:damage(10), Events.fire("hit", u, 7), u[key](u, 3), Hero.name, Hero.count, tostring(getmetatable(h) == Hero.prototype)
end
`;

// Registry classes: built from returned member tables, looked up by their
// full name and given metatables later.
const REGISTRY_CLASSES = `
local System = {}
local classes = {}
function System.define(name, creator)
    local cls = creator()
    cls.__name__ = name
    cls.__index = cls
    if cls.base then setmetatable(cls, {__index = classes[cls.base]}) end
    classes[name] = cls
    return cls
end
function System.new(name, ...)
    local cls = classes[name]
    local this = setmetatable({}, cls)
    if cls.__ctor__ then cls.__ctor__(this, ...) end
    return this
end
function System.getClass(name) return classes[name] end
System.define("Game.Unit", function()
    local __ctor__ = function(this, hp) this.Hp = hp end
    local GetHp = function(this) return this.Hp end
    local Hit = function(this, n) this.Hp = this.Hp - n; return this:GetHp() end
    return {__ctor__ = __ctor__, GetHp = GetHp, Hit = Hit}
end)
System.define("Game.Hero", function()
    local __ctor__ = function(this, hp, name)
        System.getClass("Game.Unit").__ctor__(this, hp)
        this.Name = name
    end
    local Describe = function(this) return this.Name .. ":" .. this:GetHp() end
    return {base = "Game.Unit", __ctor__ = __ctor__, Describe = Describe}
end)
function config() end
function main()
    local h = System.new("Game.Hero", 30, "Arthas")
    local member = "Hit"
    h[member](h, 4)
    return h:Describe(), System.getClass("Game.Hero").__name__, h.Hp
end
`;

test('metatable class code keeps its results through protection presets on a format 39 map', () => {
    // Fields of tables that meet a metatable, dynamic key or escape stay readable.
    const openFields = [[PROTOTYPE_CLASSES, ['prototype', '____constructor', 'damage', 'armor', '__index', 'hp', 'level', 'name']],
        [REGISTRY_CLASSES, ['__index', '__name__', '__ctor__', 'GetHp', 'base', 'Hp', 'Name']]];
    for (const [script, fields] of openFields) {
        const expected = luaResult(script), source = createLuaMap({ script, version: 39 });
        for (const preset of ['protect', 'hardened', 'maximum']) {
            const { config } = resolveSettings({ preset });
            const result = protectMap(source, config), code = openMap(result.bytes).read('war3map.lua').toString('utf8');
            assert.notEqual(code, script, preset);
            assert.deepEqual(luaResult(code), expected, preset);
            for (const field of fields) assert.match(code, new RegExp('[.:]' + field + '\\b'), preset + ' keeps ' + field);
        }
    }
});

test('bundled module loaders and environment path walks are refused with their source location', () => {
    const bundle = `
local ____modules = {}
local ____originalRequire = require
local function require(file)
    if ____modules[file] then return ____modules[file]() end
    if ____originalRequire then return ____originalRequire(file) end
    error("module '" .. file .. "' not found")
end
____modules["units"] = function() return {make = function(hp) return {hp = hp} end} end
function config() end
function main() return require("units").make(7).hp end
`;
    const pathWalk = `
local function resolve(path)
    local t = _G
    for part in path:gmatch("[^.]+") do t = t[part] end
    return t
end
Game = {Unit = {Create = function(hp) return {Hp = hp} end}}
function config() end
function main() return resolve("Game.Unit").Create(5).Hp end
`;
    const cases = [
        [bundle, 'protect', /Cause: require loads external code at war3map\.lua:6:.*--no-minify --no-rename/],
        [bundle, 'maximum', /Cause: require can load code or inspect names at war3map\.lua:3:.*--no-rename-globals --no-rename-fields/],
        [pathWalk, 'protect', /Cause: loader or environment returned beyond its local alias at war3map\.lua:5:.*--no-minify --no-rename/],
        [pathWalk, 'maximum', /Cause: _G is used as a value at war3map\.lua:3:.*--no-rename-globals --no-rename-fields/],
    ];
    for (const [script, preset, pattern] of cases) {
        assert.throws(() => protectMap(createLuaMap({ script, version: 39 }), resolveSettings({ preset }).config), pattern, preset);
    }
    // Leaving the Lua text untouched still lets the archive be optimized.
    for (const script of [bundle, pathWalk]) {
        const source = createLuaMap({ script, version: 39 });
        const result = protectMap(source, { lua: { minify: false, renameLocals: false } });
        assert.equal(openMap(result.bytes).read('war3map.lua').toString('utf8'), script);
    }
});
