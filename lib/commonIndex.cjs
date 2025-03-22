'use strict';

var require$$0$1 = require('util');
var require$$0$2 = require('url');
var require$$1 = require('http');
var require$$2 = require('https');
var require$$3 = require('zlib');
var require$$1$1 = require('fs');
var require$$2$1 = require('process');
var require$$1$2 = require('v8');
var require$$3$1 = require('cluster');

function getAugmentedNamespace(n) {
  if (Object.prototype.hasOwnProperty.call(n, '__esModule')) return n;
  var f = n.default;
	if (typeof f == "function") {
		var a = function a () {
			if (this instanceof a) {
        return Reflect.construct(f, arguments, this.constructor);
			}
			return f.apply(this, arguments);
		};
		a.prototype = f.prototype;
  } else a = {};
  Object.defineProperty(a, '__esModule', {value: true});
	Object.keys(n).forEach(function (k) {
		var d = Object.getOwnPropertyDescriptor(n, k);
		Object.defineProperty(a, k, d.get ? d : {
			enumerable: true,
			get: function () {
				return n[k];
			}
		});
	});
	return a;
}

var promClient = {};

var registry = {exports: {}};

var util = {};

var hasRequiredUtil;

function requireUtil () {
	if (hasRequiredUtil) return util;
	hasRequiredUtil = 1;

	util.getValueAsString = function getValueString(value) {
		if (Number.isNaN(value)) {
			return 'Nan';
		} else if (!Number.isFinite(value)) {
			if (value < 0) {
				return '-Inf';
			} else {
				return '+Inf';
			}
		} else {
			return `${value}`;
		}
	};

	util.removeLabels = function removeLabels(
		hashMap,
		labels,
		sortedLabelNames,
	) {
		const hash = hashObject(labels, sortedLabelNames);
		delete hashMap[hash];
	};

	util.setValue = function setValue(hashMap, value, labels) {
		const hash = hashObject(labels);
		hashMap[hash] = {
			value: typeof value === 'number' ? value : 0,
			labels: labels || {},
		};
		return hashMap;
	};

	util.setValueDelta = function setValueDelta(
		hashMap,
		deltaValue,
		labels,
		hash = '',
	) {
		const value = typeof deltaValue === 'number' ? deltaValue : 0;
		if (hashMap[hash]) {
			hashMap[hash].value += value;
		} else {
			hashMap[hash] = { value, labels };
		}
		return hashMap;
	};

	util.getLabels = function (labelNames, args) {
		if (typeof args[0] === 'object') {
			return args[0];
		}

		if (labelNames.length !== args.length) {
			throw new Error(
				`Invalid number of arguments (${args.length}): "${args.join(
					', ',
				)}" for label names (${labelNames.length}): "${labelNames.join(', ')}".`,
			);
		}

		const acc = {};
		for (let i = 0; i < labelNames.length; i++) {
			acc[labelNames[i]] = args[i];
		}
		return acc;
	};

	function fastHashObject(keys, labels) {
		if (keys.length === 0) {
			return '';
		}

		let hash = '';

		for (let i = 0; i < keys.length; i++) {
			const key = keys[i];
			const value = labels[key];
			if (value === undefined) continue;

			hash += `${key}:${value},`;
		}

		return hash;
	}

	function hashObject(labels, labelNames) {
		// We don't actually need a hash here. We just need a string that
		// is unique for each possible labels object and consistent across
		// calls with equivalent labels objects.

		if (labelNames) {
			return fastHashObject(labelNames, labels);
		}

		const keys = Object.keys(labels);
		if (keys.length > 1) {
			keys.sort(); // need consistency across calls
		}

		return fastHashObject(keys, labels);
	}
	util.hashObject = hashObject;

	util.isObject = function isObject(obj) {
		return obj !== null && typeof obj === 'object';
	};

	util.nowTimestamp = function nowTimestamp() {
		return Date.now() / 1000;
	};

	class Grouper extends Map {
		/**
		 * Adds the `value` to the `key`'s array of values.
		 * @param {*} key Key to set.
		 * @param {*} value Value to add to `key`'s array.
		 * @returns {undefined} undefined.
		 */
		add(key, value) {
			if (this.has(key)) {
				this.get(key).push(value);
			} else {
				this.set(key, [value]);
			}
		}
	}

	util.Grouper = Grouper;
	return util;
}

var hasRequiredRegistry;

function requireRegistry () {
	if (hasRequiredRegistry) return registry.exports;
	hasRequiredRegistry = 1;

	const { getValueAsString } = requireUtil();

	class Registry {
		static get PROMETHEUS_CONTENT_TYPE() {
			return 'text/plain; version=0.0.4; charset=utf-8';
		}

		static get OPENMETRICS_CONTENT_TYPE() {
			return 'application/openmetrics-text; version=1.0.0; charset=utf-8';
		}

		constructor(regContentType = Registry.PROMETHEUS_CONTENT_TYPE) {
			this._metrics = {};
			this._collectors = [];
			this._defaultLabels = {};
			if (
				regContentType !== Registry.PROMETHEUS_CONTENT_TYPE &&
				regContentType !== Registry.OPENMETRICS_CONTENT_TYPE
			) {
				throw new TypeError(`Content type ${regContentType} is unsupported`);
			}
			this._contentType = regContentType;
		}

		getMetricsAsArray() {
			return Object.values(this._metrics);
		}

		async getMetricsAsString(metrics) {
			const metric =
				typeof metrics.getForPromString === 'function'
					? await metrics.getForPromString()
					: await metrics.get();

			const name = escapeString(metric.name);
			const help = `# HELP ${name} ${escapeString(metric.help)}`;
			const type = `# TYPE ${name} ${metric.type}`;
			const values = [help, type];

			const defaultLabels =
				Object.keys(this._defaultLabels).length > 0 ? this._defaultLabels : null;

			const isOpenMetrics =
				this.contentType === Registry.OPENMETRICS_CONTENT_TYPE;

			for (const val of metric.values || []) {
				let { metricName = name, labels = {} } = val;
				const { sharedLabels = {} } = val;
				if (isOpenMetrics && metric.type === 'counter') {
					metricName = `${metricName}_total`;
				}

				if (defaultLabels) {
					labels = { ...labels, ...defaultLabels, ...labels };
				}

				// We have to flatten these separately to avoid duplicate labels appearing
				// between the base labels and the shared labels
				const formattedLabels = formatLabels(labels, sharedLabels);

				const flattenedShared = flattenSharedLabels(sharedLabels);
				const labelParts = [...formattedLabels, flattenedShared].filter(Boolean);
				const labelsString = labelParts.length ? `{${labelParts.join(',')}}` : '';
				let fullMetricLine = `${metricName}${labelsString} ${getValueAsString(
					val.value,
				)}`;

				const { exemplar } = val;
				if (exemplar && isOpenMetrics) {
					const formattedExemplars = formatLabels(exemplar.labelSet);
					fullMetricLine += ` # {${formattedExemplars.join(
						',',
					)}} ${getValueAsString(exemplar.value)} ${exemplar.timestamp}`;
				}
				values.push(fullMetricLine);
			}

			return values.join('\n');
		}

		async metrics() {
			const isOpenMetrics =
				this.contentType === Registry.OPENMETRICS_CONTENT_TYPE;

			const promises = this.getMetricsAsArray().map(metric => {
				if (isOpenMetrics && metric.type === 'counter') {
					metric.name = standardizeCounterName(metric.name);
				}
				return this.getMetricsAsString(metric);
			});

			const resolves = await Promise.all(promises);

			return isOpenMetrics
				? `${resolves.join('\n')}\n# EOF\n`
				: `${resolves.join('\n\n')}\n`;
		}

		registerMetric(metric) {
			if (this._metrics[metric.name] && this._metrics[metric.name] !== metric) {
				throw new Error(
					`A metric with the name ${metric.name} has already been registered.`,
				);
			}

			this._metrics[metric.name] = metric;
		}

		clear() {
			this._metrics = {};
			this._defaultLabels = {};
		}

		async getMetricsAsJSON() {
			const metrics = [];
			const defaultLabelNames = Object.keys(this._defaultLabels);

			const promises = [];

			for (const metric of this.getMetricsAsArray()) {
				promises.push(metric.get());
			}

			const resolves = await Promise.all(promises);

			for (const item of resolves) {
				if (item.values && defaultLabelNames.length > 0) {
					for (const val of item.values) {
						// Make a copy before mutating
						val.labels = Object.assign({}, val.labels);

						for (const labelName of defaultLabelNames) {
							val.labels[labelName] =
								val.labels[labelName] || this._defaultLabels[labelName];
						}
					}
				}

				metrics.push(item);
			}

			return metrics;
		}

		removeSingleMetric(name) {
			delete this._metrics[name];
		}

		getSingleMetricAsString(name) {
			return this.getMetricsAsString(this._metrics[name]);
		}

		getSingleMetric(name) {
			return this._metrics[name];
		}

		setDefaultLabels(labels) {
			this._defaultLabels = labels;
		}

		resetMetrics() {
			for (const metric in this._metrics) {
				this._metrics[metric].reset();
			}
		}

		get contentType() {
			return this._contentType;
		}

		setContentType(metricsContentType) {
			if (
				metricsContentType === Registry.OPENMETRICS_CONTENT_TYPE ||
				metricsContentType === Registry.PROMETHEUS_CONTENT_TYPE
			) {
				this._contentType = metricsContentType;
			} else {
				throw new Error(`Content type ${metricsContentType} is unsupported`);
			}
		}

		static merge(registers) {
			const regType = registers[0].contentType;
			for (const reg of registers) {
				if (reg.contentType !== regType) {
					throw new Error(
						'Registers can only be merged if they have the same content type',
					);
				}
			}
			const mergedRegistry = new Registry(regType);

			const metricsToMerge = registers.reduce(
				(acc, reg) => acc.concat(reg.getMetricsAsArray()),
				[],
			);

			metricsToMerge.forEach(mergedRegistry.registerMetric, mergedRegistry);
			return mergedRegistry;
		}
	}

	function formatLabels(labels, exclude) {
		const { hasOwnProperty } = Object.prototype;
		const formatted = [];
		for (const [name, value] of Object.entries(labels)) {
			if (!exclude || !hasOwnProperty.call(exclude, name)) {
				formatted.push(`${name}="${escapeLabelValue(value)}"`);
			}
		}
		return formatted;
	}

	const sharedLabelCache = new WeakMap();
	function flattenSharedLabels(labels) {
		const cached = sharedLabelCache.get(labels);
		if (cached) {
			return cached;
		}

		const formattedLabels = formatLabels(labels);
		const flattened = formattedLabels.join(',');
		sharedLabelCache.set(labels, flattened);
		return flattened;
	}
	function escapeLabelValue(str) {
		if (typeof str !== 'string') {
			return str;
		}
		return escapeString(str).replace(/"/g, '\\"');
	}
	function escapeString(str) {
		return str.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
	}
	function standardizeCounterName(name) {
		return name.replace(/_total$/, '');
	}

	registry.exports = Registry;
	registry.exports.globalRegistry = new Registry();
	return registry.exports;
}

var validation = {};

var hasRequiredValidation;

function requireValidation () {
	if (hasRequiredValidation) return validation;
	hasRequiredValidation = 1;

	const util = require$$0$1;

	// These are from https://prometheus.io/docs/concepts/data_model/#metric-names-and-labels
	const metricRegexp = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
	const labelRegexp = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

	validation.validateMetricName = function (name) {
		return metricRegexp.test(name);
	};

	validation.validateLabelName = function (names = []) {
		return names.every(name => labelRegexp.test(name));
	};

	validation.validateLabel = function validateLabel(savedLabels, labels) {
		for (const label in labels) {
			if (!savedLabels.includes(label)) {
				throw new Error(
					`Added label "${label}" is not included in initial labelset: ${util.inspect(
						savedLabels,
					)}`,
				);
			}
		}
	};
	return validation;
}

var metric;
var hasRequiredMetric;

function requireMetric () {
	if (hasRequiredMetric) return metric;
	hasRequiredMetric = 1;

	const Registry = requireRegistry();
	const { isObject } = requireUtil();
	const { validateMetricName, validateLabelName } = requireValidation();

	/**
	 * @abstract
	 */
	class Metric {
		constructor(config, defaults = {}) {
			if (!isObject(config)) {
				throw new TypeError('constructor expected a config object');
			}
			Object.assign(
				this,
				{
					labelNames: [],
					registers: [Registry.globalRegistry],
					aggregator: 'sum',
					enableExemplars: false,
				},
				defaults,
				config,
			);
			if (!this.registers) {
				// in case config.registers is `undefined`
				this.registers = [Registry.globalRegistry];
			}
			if (!this.help) {
				throw new Error('Missing mandatory help parameter');
			}
			if (!this.name) {
				throw new Error('Missing mandatory name parameter');
			}
			if (!validateMetricName(this.name)) {
				throw new Error('Invalid metric name');
			}
			if (!validateLabelName(this.labelNames)) {
				throw new Error('Invalid label name');
			}

			if (this.collect && typeof this.collect !== 'function') {
				throw new Error('Optional "collect" parameter must be a function');
			}

			if (this.labelNames) {
				this.sortedLabelNames = [...this.labelNames].sort();
			} else {
				this.sortedLabelNames = [];
			}

			this.reset();

			for (const register of this.registers) {
				if (
					this.enableExemplars &&
					register.contentType === Registry.PROMETHEUS_CONTENT_TYPE
				) {
					throw new TypeError(
						'Exemplars are supported only on OpenMetrics registries',
					);
				}
				register.registerMetric(this);
			}
		}

		reset() {
			/* abstract */
		}
	}

	metric = { Metric };
	return metric;
}

var exemplar;
var hasRequiredExemplar;

function requireExemplar () {
	if (hasRequiredExemplar) return exemplar;
	hasRequiredExemplar = 1;

	/**
	 * Class representing an OpenMetrics exemplar.
	 *
	 * @property {object} labelSet
	 * @property {number} value
	 * @property {number} [timestamp]
	 * */
	class Exemplar {
		constructor(labelSet = {}, value = null) {
			this.labelSet = labelSet;
			this.value = value;
		}

		/**
		 * Validation for the label set format.
		 * https://github.com/OpenObservability/OpenMetrics/blob/d99b705f611b75fec8f450b05e344e02eea6921d/specification/OpenMetrics.md#exemplars
		 *
		 * @param {object} labelSet - Exemplar labels.
		 * @throws {RangeError}
		 * @return {void}
		 */
		validateExemplarLabelSet(labelSet) {
			let res = '';
			for (const [labelName, labelValue] of Object.entries(labelSet)) {
				res += `${labelName}${labelValue}`;
			}
			if (res.length > 128) {
				throw new RangeError(
					'Label set size must be smaller than 128 UTF-8 chars',
				);
			}
		}
	}

	exemplar = Exemplar;
	return exemplar;
}

/**
 * Counter metric
 */

var counter;
var hasRequiredCounter;

function requireCounter () {
	if (hasRequiredCounter) return counter;
	hasRequiredCounter = 1;

	const util = require$$0$1;
	const {
		hashObject,
		isObject,
		getLabels,
		removeLabels,
		nowTimestamp,
	} = requireUtil();
	const { validateLabel } = requireValidation();
	const { Metric } = requireMetric();
	const Exemplar = requireExemplar();

	class Counter extends Metric {
		constructor(config) {
			super(config);
			this.type = 'counter';
			this.defaultLabels = {};
			this.defaultValue = 1;
			this.defaultExemplarLabelSet = {};
			if (config.enableExemplars) {
				this.enableExemplars = true;
				this.inc = this.incWithExemplar;
			} else {
				this.inc = this.incWithoutExemplar;
			}
		}

		/**
		 * Increment counter
		 * @param {object} labels - What label you want to be incremented
		 * @param {Number} value - Value to increment, if omitted increment with 1
		 * @returns {object} results - object with information about the inc operation
		 * @returns {string} results.labelHash - hash representation of the labels
		 */
		incWithoutExemplar(labels, value) {
			let hash = '';
			if (isObject(labels)) {
				hash = hashObject(labels, this.sortedLabelNames);
				validateLabel(this.labelNames, labels);
			} else {
				value = labels;
				labels = {};
			}

			if (value && !Number.isFinite(value)) {
				throw new TypeError(`Value is not a valid number: ${util.format(value)}`);
			}
			if (value < 0) {
				throw new Error('It is not possible to decrease a counter');
			}

			if (value === null || value === undefined) value = 1;

			setValue(this.hashMap, value, labels, hash);

			return { labelHash: hash };
		}

		/**
		 * Increment counter with exemplar, same as inc but accepts labels for an
		 * exemplar.
		 * If no label is provided the current exemplar labels are kept unchanged
		 * (defaults to empty set).
		 *
		 * @param {object} incOpts - Object with options about what metric to increase
		 * @param {object} incOpts.labels - What label you want to be incremented,
		 *                                  defaults to null (metric with no labels)
		 * @param {Number} incOpts.value - Value to increment, defaults to 1
		 * @param {object} incOpts.exemplarLabels - Key-value  labels for the
		 *                                          exemplar, defaults to empty set {}
		 * @returns {void}
		 */
		incWithExemplar({
			labels = this.defaultLabels,
			value = this.defaultValue,
			exemplarLabels = this.defaultExemplarLabelSet,
		} = {}) {
			const res = this.incWithoutExemplar(labels, value);
			this.updateExemplar(exemplarLabels, value, res.labelHash);
		}

		updateExemplar(exemplarLabels, value, hash) {
			if (exemplarLabels === this.defaultExemplarLabelSet) return;
			if (!isObject(this.hashMap[hash].exemplar)) {
				this.hashMap[hash].exemplar = new Exemplar();
			}
			this.hashMap[hash].exemplar.validateExemplarLabelSet(exemplarLabels);
			this.hashMap[hash].exemplar.labelSet = exemplarLabels;
			this.hashMap[hash].exemplar.value = value ? value : 1;
			this.hashMap[hash].exemplar.timestamp = nowTimestamp();
		}

		/**
		 * Reset counter
		 * @returns {void}
		 */
		reset() {
			this.hashMap = {};
			if (this.labelNames.length === 0) {
				setValue(this.hashMap, 0);
			}
		}

		async get() {
			if (this.collect) {
				const v = this.collect();
				if (v instanceof Promise) await v;
			}

			return {
				help: this.help,
				name: this.name,
				type: this.type,
				values: Object.values(this.hashMap),
				aggregator: this.aggregator,
			};
		}

		labels(...args) {
			const labels = getLabels(this.labelNames, args) || {};
			return {
				inc: this.inc.bind(this, labels),
			};
		}

		remove(...args) {
			const labels = getLabels(this.labelNames, args) || {};
			validateLabel(this.labelNames, labels);
			return removeLabels.call(this, this.hashMap, labels, this.sortedLabelNames);
		}
	}

	function setValue(hashMap, value, labels = {}, hash = '') {
		if (hashMap[hash]) {
			hashMap[hash].value += value;
		} else {
			hashMap[hash] = { value, labels };
		}
		return hashMap;
	}

	counter = Counter;
	return counter;
}

/**
 * Gauge metric
 */

var gauge;
var hasRequiredGauge;

function requireGauge () {
	if (hasRequiredGauge) return gauge;
	hasRequiredGauge = 1;

	const util = require$$0$1;

	const {
		setValue,
		setValueDelta,
		getLabels,
		hashObject,
		isObject,
		removeLabels,
	} = requireUtil();
	const { validateLabel } = requireValidation();
	const { Metric } = requireMetric();

	class Gauge extends Metric {
		constructor(config) {
			super(config);
			this.type = 'gauge';
		}

		/**
		 * Set a gauge to a value
		 * @param {object} labels - Object with labels and their values
		 * @param {Number} value - Value to set the gauge to, must be positive
		 * @returns {void}
		 */
		set(labels, value) {
			value = getValueArg(labels, value);
			labels = getLabelArg(labels);
			set(this, labels, value);
		}

		/**
		 * Reset gauge
		 * @returns {void}
		 */
		reset() {
			this.hashMap = {};
			if (this.labelNames.length === 0) {
				setValue(this.hashMap, 0, {});
			}
		}

		/**
		 * Increment a gauge value
		 * @param {object} labels - Object with labels where key is the label key and value is label value. Can only be one level deep
		 * @param {Number} value - Value to increment - if omitted, increment with 1
		 * @returns {void}
		 */
		inc(labels, value) {
			value = getValueArg(labels, value);
			labels = getLabelArg(labels);
			if (value === undefined) value = 1;
			setDelta(this, labels, value);
		}

		/**
		 * Decrement a gauge value
		 * @param {object} labels - Object with labels where key is the label key and value is label value. Can only be one level deep
		 * @param {Number} value - Value to decrement - if omitted, decrement with 1
		 * @returns {void}
		 */
		dec(labels, value) {
			value = getValueArg(labels, value);
			labels = getLabelArg(labels);
			if (value === undefined) value = 1;
			setDelta(this, labels, -value);
		}

		/**
		 * Set the gauge to current unix epoch
		 * @param {object} labels - Object with labels where key is the label key and value is label value. Can only be one level deep
		 * @returns {void}
		 */
		setToCurrentTime(labels) {
			const now = Date.now() / 1000;
			if (labels === undefined) {
				this.set(now);
			} else {
				this.set(labels, now);
			}
		}

		/**
		 * Start a timer
		 * @param {object} labels - Object with labels where key is the label key and value is label value. Can only be one level deep
		 * @returns {function} - Invoke this function to set the duration in seconds since you started the timer.
		 * @example
		 * var done = gauge.startTimer();
		 * makeXHRRequest(function(err, response) {
		 *	done(); //Duration of the request will be saved
		 * });
		 */
		startTimer(labels) {
			const start = process.hrtime();
			return endLabels => {
				const delta = process.hrtime(start);
				const value = delta[0] + delta[1] / 1e9;
				this.set(Object.assign({}, labels, endLabels), value);
				return value;
			};
		}

		async get() {
			if (this.collect) {
				const v = this.collect();
				if (v instanceof Promise) await v;
			}
			return {
				help: this.help,
				name: this.name,
				type: this.type,
				values: Object.values(this.hashMap),
				aggregator: this.aggregator,
			};
		}

		_getValue(labels) {
			const hash = hashObject(labels || {}, this.sortedLabelNames);
			return this.hashMap[hash] ? this.hashMap[hash].value : 0;
		}

		labels(...args) {
			const labels = getLabels(this.labelNames, args);
			validateLabel(this.labelNames, labels);
			return {
				inc: this.inc.bind(this, labels),
				dec: this.dec.bind(this, labels),
				set: this.set.bind(this, labels),
				setToCurrentTime: this.setToCurrentTime.bind(this, labels),
				startTimer: this.startTimer.bind(this, labels),
			};
		}

		remove(...args) {
			const labels = getLabels(this.labelNames, args);
			validateLabel(this.labelNames, labels);
			removeLabels.call(this, this.hashMap, labels, this.sortedLabelNames);
		}
	}

	function set(gauge, labels, value) {
		if (typeof value !== 'number') {
			throw new TypeError(`Value is not a valid number: ${util.format(value)}`);
		}

		validateLabel(gauge.labelNames, labels);
		setValue(gauge.hashMap, value, labels);
	}

	function setDelta(gauge, labels, delta) {
		if (typeof delta !== 'number') {
			throw new TypeError(`Delta is not a valid number: ${util.format(delta)}`);
		}

		validateLabel(gauge.labelNames, labels);
		const hash = hashObject(labels, gauge.sortedLabelNames);
		setValueDelta(gauge.hashMap, delta, labels, hash);
	}

	function getLabelArg(labels) {
		return isObject(labels) ? labels : {};
	}

	function getValueArg(labels, value) {
		return isObject(labels) ? value : labels;
	}

	gauge = Gauge;
	return gauge;
}

/**
 * Histogram
 */

var histogram;
var hasRequiredHistogram;

function requireHistogram () {
	if (hasRequiredHistogram) return histogram;
	hasRequiredHistogram = 1;

	const util = require$$0$1;
	const {
		getLabels,
		hashObject,
		isObject,
		removeLabels,
		nowTimestamp,
	} = requireUtil();
	const { validateLabel } = requireValidation();
	const { Metric } = requireMetric();
	const Exemplar = requireExemplar();

	class Histogram extends Metric {
		constructor(config) {
			super(config, {
				buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
			});

			this.type = 'histogram';
			this.defaultLabels = {};
			this.defaultExemplarLabelSet = {};
			this.enableExemplars = false;

			for (const label of this.labelNames) {
				if (label === 'le') {
					throw new Error('le is a reserved label keyword');
				}
			}

			this.upperBounds = this.buckets;
			this.bucketValues = this.upperBounds.reduce((acc, upperBound) => {
				acc[upperBound] = 0;
				return acc;
			}, {});

			if (config.enableExemplars) {
				this.enableExemplars = true;
				this.bucketExemplars = this.upperBounds.reduce((acc, upperBound) => {
					acc[upperBound] = null;
					return acc;
				}, {});
				Object.freeze(this.bucketExemplars);
				this.observe = this.observeWithExemplar;
			} else {
				this.observe = this.observeWithoutExemplar;
			}

			Object.freeze(this.bucketValues);
			Object.freeze(this.upperBounds);

			if (this.labelNames.length === 0) {
				this.hashMap = {
					[hashObject({})]: createBaseValues(
						{},
						this.bucketValues,
						this.bucketExemplars,
					),
				};
			}
		}

		/**
		 * Observe a value in histogram
		 * @param {object} labels - Object with labels where key is the label key and value is label value. Can only be one level deep
		 * @param {Number} value - Value to observe in the histogram
		 * @returns {void}
		 */
		observeWithoutExemplar(labels, value) {
			observe.call(this, labels === 0 ? 0 : labels || {})(value);
		}

		observeWithExemplar({
			labels = this.defaultLabels,
			value,
			exemplarLabels = this.defaultExemplarLabelSet,
		} = {}) {
			observe.call(this, labels === 0 ? 0 : labels || {})(value);
			this.updateExemplar(labels, value, exemplarLabels);
		}

		updateExemplar(labels, value, exemplarLabels) {
			if (Object.keys(exemplarLabels).length === 0) return;
			const hash = hashObject(labels, this.sortedLabelNames);
			const bound = findBound(this.upperBounds, value);
			const { bucketExemplars } = this.hashMap[hash];
			let exemplar = bucketExemplars[bound];
			if (!isObject(exemplar)) {
				exemplar = new Exemplar();
				bucketExemplars[bound] = exemplar;
			}
			exemplar.validateExemplarLabelSet(exemplarLabels);
			exemplar.labelSet = exemplarLabels;
			exemplar.value = value;
			exemplar.timestamp = nowTimestamp();
		}

		async get() {
			const data = await this.getForPromString();
			data.values = data.values.map(splayLabels);
			return data;
		}

		async getForPromString() {
			if (this.collect) {
				const v = this.collect();
				if (v instanceof Promise) await v;
			}
			const data = Object.values(this.hashMap);
			const values = data
				.map(extractBucketValuesForExport(this))
				.reduce(addSumAndCountForExport(this), []);

			return {
				name: this.name,
				help: this.help,
				type: this.type,
				values,
				aggregator: this.aggregator,
			};
		}

		reset() {
			this.hashMap = {};
		}

		/**
		 * Initialize the metrics for the given combination of labels to zero
		 * @param {object} labels - Object with labels where key is the label key and value is label value. Can only be one level deep
		 * @returns {void}
		 */
		zero(labels) {
			const hash = hashObject(labels, this.sortedLabelNames);
			this.hashMap[hash] = createBaseValues(
				labels,
				this.bucketValues,
				this.bucketExemplars,
			);
		}

		/**
		 * Start a timer that could be used to logging durations
		 * @param {object} labels - Object with labels where key is the label key and value is label value. Can only be one level deep
		 * @param {object} exemplarLabels - Object with labels for exemplar where key is the label key and value is label value. Can only be one level deep
		 * @returns {function} - Function to invoke when you want to stop the timer and observe the duration in seconds
		 * @example
		 * var end = histogram.startTimer();
		 * makeExpensiveXHRRequest(function(err, res) {
		 * 	const duration = end(); //Observe the duration of expensiveXHRRequest and returns duration in seconds
		 * 	console.log('Duration', duration);
		 * });
		 */
		startTimer(labels, exemplarLabels) {
			return this.enableExemplars
				? startTimerWithExemplar.call(this, labels, exemplarLabels)()
				: startTimer.call(this, labels)();
		}

		labels(...args) {
			const labels = getLabels(this.labelNames, args);
			validateLabel(this.labelNames, labels);
			return {
				observe: observe.call(this, labels),
				startTimer: startTimer.call(this, labels),
			};
		}

		remove(...args) {
			const labels = getLabels(this.labelNames, args);
			validateLabel(this.labelNames, labels);
			removeLabels.call(this, this.hashMap, labels, this.sortedLabelNames);
		}
	}

	function startTimer(startLabels) {
		return () => {
			const start = process.hrtime();
			return endLabels => {
				const delta = process.hrtime(start);
				const value = delta[0] + delta[1] / 1e9;
				this.observe(Object.assign({}, startLabels, endLabels), value);
				return value;
			};
		};
	}

	function startTimerWithExemplar(startLabels, startExemplarLabels) {
		return () => {
			const start = process.hrtime();
			return (endLabels, endExemplarLabels) => {
				const delta = process.hrtime(start);
				const value = delta[0] + delta[1] / 1e9;
				this.observe({
					labels: Object.assign({}, startLabels, endLabels),
					value,
					exemplarLabels: Object.assign(
						{},
						startExemplarLabels,
						endExemplarLabels,
					),
				});
				return value;
			};
		};
	}

	function setValuePair(labels, value, metricName, exemplar, sharedLabels = {}) {
		return {
			labels,
			sharedLabels,
			value,
			metricName,
			exemplar,
		};
	}

	function findBound(upperBounds, value) {
		for (let i = 0; i < upperBounds.length; i++) {
			const bound = upperBounds[i];
			if (value <= bound) {
				return bound;
			}
		}
		return -1;
	}

	function observe(labels) {
		return value => {
			const labelValuePair = convertLabelsAndValues(labels, value);

			validateLabel(this.labelNames, labelValuePair.labels);
			if (!Number.isFinite(labelValuePair.value)) {
				throw new TypeError(
					`Value is not a valid number: ${util.format(labelValuePair.value)}`,
				);
			}

			const hash = hashObject(labelValuePair.labels, this.sortedLabelNames);
			let valueFromMap = this.hashMap[hash];
			if (!valueFromMap) {
				valueFromMap = createBaseValues(
					labelValuePair.labels,
					this.bucketValues,
					this.bucketExemplars,
				);
			}

			const b = findBound(this.upperBounds, labelValuePair.value);

			valueFromMap.sum += labelValuePair.value;
			valueFromMap.count += 1;

			if (Object.prototype.hasOwnProperty.call(valueFromMap.bucketValues, b)) {
				valueFromMap.bucketValues[b] += 1;
			}

			this.hashMap[hash] = valueFromMap;
		};
	}

	function createBaseValues(labels, bucketValues, bucketExemplars) {
		const result = {
			labels,
			bucketValues: { ...bucketValues },
			sum: 0,
			count: 0,
		};
		if (bucketExemplars) {
			result.bucketExemplars = { ...bucketExemplars };
		}
		return result;
	}

	function convertLabelsAndValues(labels, value) {
		return isObject(labels)
			? {
					labels,
					value,
				}
			: {
					value: labels,
					labels: {},
				};
	}

	function extractBucketValuesForExport(histogram) {
		const name = `${histogram.name}_bucket`;
		return bucketData => {
			let acc = 0;
			const buckets = histogram.upperBounds.map(upperBound => {
				acc += bucketData.bucketValues[upperBound];
				return setValuePair(
					{ le: upperBound },
					acc,
					name,
					bucketData.bucketExemplars
						? bucketData.bucketExemplars[upperBound]
						: null,
					bucketData.labels,
				);
			});
			return { buckets, data: bucketData };
		};
	}

	function addSumAndCountForExport(histogram) {
		return (acc, d) => {
			acc.push(...d.buckets);

			const infLabel = { le: '+Inf' };
			acc.push(
				setValuePair(
					infLabel,
					d.data.count,
					`${histogram.name}_bucket`,
					d.data.bucketExemplars ? d.data.bucketExemplars['-1'] : null,
					d.data.labels,
				),
				setValuePair(
					{},
					d.data.sum,
					`${histogram.name}_sum`,
					undefined,
					d.data.labels,
				),
				setValuePair(
					{},
					d.data.count,
					`${histogram.name}_count`,
					undefined,
					d.data.labels,
				),
			);
			return acc;
		};
	}

	function splayLabels(bucket) {
		const { sharedLabels, labels, ...newBucket } = bucket;
		for (const label of Object.keys(sharedLabels)) {
			labels[label] = sharedLabels[label];
		}
		newBucket.labels = labels;
		return newBucket;
	}

	histogram = Histogram;
	return histogram;
}

var treebase;
var hasRequiredTreebase;

function requireTreebase () {
	if (hasRequiredTreebase) return treebase;
	hasRequiredTreebase = 1;
	function TreeBase() {}

	// removes all nodes from the tree
	TreeBase.prototype.clear = function() {
	    this._root = null;
	    this.size = 0;
	};

	// returns node data if found, null otherwise
	TreeBase.prototype.find = function(data) {
	    var res = this._root;

	    while(res !== null) {
	        var c = this._comparator(data, res.data);
	        if(c === 0) {
	            return res.data;
	        }
	        else {
	            res = res.get_child(c > 0);
	        }
	    }

	    return null;
	};

	// returns iterator to node if found, null otherwise
	TreeBase.prototype.findIter = function(data) {
	    var res = this._root;
	    var iter = this.iterator();

	    while(res !== null) {
	        var c = this._comparator(data, res.data);
	        if(c === 0) {
	            iter._cursor = res;
	            return iter;
	        }
	        else {
	            iter._ancestors.push(res);
	            res = res.get_child(c > 0);
	        }
	    }

	    return null;
	};

	// Returns an iterator to the tree node at or immediately after the item
	TreeBase.prototype.lowerBound = function(item) {
	    var cur = this._root;
	    var iter = this.iterator();
	    var cmp = this._comparator;

	    while(cur !== null) {
	        var c = cmp(item, cur.data);
	        if(c === 0) {
	            iter._cursor = cur;
	            return iter;
	        }
	        iter._ancestors.push(cur);
	        cur = cur.get_child(c > 0);
	    }

	    for(var i=iter._ancestors.length - 1; i >= 0; --i) {
	        cur = iter._ancestors[i];
	        if(cmp(item, cur.data) < 0) {
	            iter._cursor = cur;
	            iter._ancestors.length = i;
	            return iter;
	        }
	    }

	    iter._ancestors.length = 0;
	    return iter;
	};

	// Returns an iterator to the tree node immediately after the item
	TreeBase.prototype.upperBound = function(item) {
	    var iter = this.lowerBound(item);
	    var cmp = this._comparator;

	    while(iter.data() !== null && cmp(iter.data(), item) === 0) {
	        iter.next();
	    }

	    return iter;
	};

	// returns null if tree is empty
	TreeBase.prototype.min = function() {
	    var res = this._root;
	    if(res === null) {
	        return null;
	    }

	    while(res.left !== null) {
	        res = res.left;
	    }

	    return res.data;
	};

	// returns null if tree is empty
	TreeBase.prototype.max = function() {
	    var res = this._root;
	    if(res === null) {
	        return null;
	    }

	    while(res.right !== null) {
	        res = res.right;
	    }

	    return res.data;
	};

	// returns a null iterator
	// call next() or prev() to point to an element
	TreeBase.prototype.iterator = function() {
	    return new Iterator(this);
	};

	// calls cb on each node's data, in order
	TreeBase.prototype.each = function(cb) {
	    var it=this.iterator(), data;
	    while((data = it.next()) !== null) {
	        if(cb(data) === false) {
	            return;
	        }
	    }
	};

	// calls cb on each node's data, in reverse order
	TreeBase.prototype.reach = function(cb) {
	    var it=this.iterator(), data;
	    while((data = it.prev()) !== null) {
	        if(cb(data) === false) {
	            return;
	        }
	    }
	};


	function Iterator(tree) {
	    this._tree = tree;
	    this._ancestors = [];
	    this._cursor = null;
	}

	Iterator.prototype.data = function() {
	    return this._cursor !== null ? this._cursor.data : null;
	};

	// if null-iterator, returns first node
	// otherwise, returns next node
	Iterator.prototype.next = function() {
	    if(this._cursor === null) {
	        var root = this._tree._root;
	        if(root !== null) {
	            this._minNode(root);
	        }
	    }
	    else {
	        if(this._cursor.right === null) {
	            // no greater node in subtree, go up to parent
	            // if coming from a right child, continue up the stack
	            var save;
	            do {
	                save = this._cursor;
	                if(this._ancestors.length) {
	                    this._cursor = this._ancestors.pop();
	                }
	                else {
	                    this._cursor = null;
	                    break;
	                }
	            } while(this._cursor.right === save);
	        }
	        else {
	            // get the next node from the subtree
	            this._ancestors.push(this._cursor);
	            this._minNode(this._cursor.right);
	        }
	    }
	    return this._cursor !== null ? this._cursor.data : null;
	};

	// if null-iterator, returns last node
	// otherwise, returns previous node
	Iterator.prototype.prev = function() {
	    if(this._cursor === null) {
	        var root = this._tree._root;
	        if(root !== null) {
	            this._maxNode(root);
	        }
	    }
	    else {
	        if(this._cursor.left === null) {
	            var save;
	            do {
	                save = this._cursor;
	                if(this._ancestors.length) {
	                    this._cursor = this._ancestors.pop();
	                }
	                else {
	                    this._cursor = null;
	                    break;
	                }
	            } while(this._cursor.left === save);
	        }
	        else {
	            this._ancestors.push(this._cursor);
	            this._maxNode(this._cursor.left);
	        }
	    }
	    return this._cursor !== null ? this._cursor.data : null;
	};

	Iterator.prototype._minNode = function(start) {
	    while(start.left !== null) {
	        this._ancestors.push(start);
	        start = start.left;
	    }
	    this._cursor = start;
	};

	Iterator.prototype._maxNode = function(start) {
	    while(start.right !== null) {
	        this._ancestors.push(start);
	        start = start.right;
	    }
	    this._cursor = start;
	};

	treebase = TreeBase;
	return treebase;
}

var rbtree;
var hasRequiredRbtree;

function requireRbtree () {
	if (hasRequiredRbtree) return rbtree;
	hasRequiredRbtree = 1;
	var TreeBase = requireTreebase();

	function Node(data) {
	    this.data = data;
	    this.left = null;
	    this.right = null;
	    this.red = true;
	}

	Node.prototype.get_child = function(dir) {
	    return dir ? this.right : this.left;
	};

	Node.prototype.set_child = function(dir, val) {
	    if(dir) {
	        this.right = val;
	    }
	    else {
	        this.left = val;
	    }
	};

	function RBTree(comparator) {
	    this._root = null;
	    this._comparator = comparator;
	    this.size = 0;
	}

	RBTree.prototype = new TreeBase();

	// returns true if inserted, false if duplicate
	RBTree.prototype.insert = function(data) {
	    var ret = false;

	    if(this._root === null) {
	        // empty tree
	        this._root = new Node(data);
	        ret = true;
	        this.size++;
	    }
	    else {
	        var head = new Node(undefined); // fake tree root

	        var dir = 0;
	        var last = 0;

	        // setup
	        var gp = null; // grandparent
	        var ggp = head; // grand-grand-parent
	        var p = null; // parent
	        var node = this._root;
	        ggp.right = this._root;

	        // search down
	        while(true) {
	            if(node === null) {
	                // insert new node at the bottom
	                node = new Node(data);
	                p.set_child(dir, node);
	                ret = true;
	                this.size++;
	            }
	            else if(is_red(node.left) && is_red(node.right)) {
	                // color flip
	                node.red = true;
	                node.left.red = false;
	                node.right.red = false;
	            }

	            // fix red violation
	            if(is_red(node) && is_red(p)) {
	                var dir2 = ggp.right === gp;

	                if(node === p.get_child(last)) {
	                    ggp.set_child(dir2, single_rotate(gp, !last));
	                }
	                else {
	                    ggp.set_child(dir2, double_rotate(gp, !last));
	                }
	            }

	            var cmp = this._comparator(node.data, data);

	            // stop if found
	            if(cmp === 0) {
	                break;
	            }

	            last = dir;
	            dir = cmp < 0;

	            // update helpers
	            if(gp !== null) {
	                ggp = gp;
	            }
	            gp = p;
	            p = node;
	            node = node.get_child(dir);
	        }

	        // update root
	        this._root = head.right;
	    }

	    // make root black
	    this._root.red = false;

	    return ret;
	};

	// returns true if removed, false if not found
	RBTree.prototype.remove = function(data) {
	    if(this._root === null) {
	        return false;
	    }

	    var head = new Node(undefined); // fake tree root
	    var node = head;
	    node.right = this._root;
	    var p = null; // parent
	    var gp = null; // grand parent
	    var found = null; // found item
	    var dir = 1;

	    while(node.get_child(dir) !== null) {
	        var last = dir;

	        // update helpers
	        gp = p;
	        p = node;
	        node = node.get_child(dir);

	        var cmp = this._comparator(data, node.data);

	        dir = cmp > 0;

	        // save found node
	        if(cmp === 0) {
	            found = node;
	        }

	        // push the red node down
	        if(!is_red(node) && !is_red(node.get_child(dir))) {
	            if(is_red(node.get_child(!dir))) {
	                var sr = single_rotate(node, dir);
	                p.set_child(last, sr);
	                p = sr;
	            }
	            else if(!is_red(node.get_child(!dir))) {
	                var sibling = p.get_child(!last);
	                if(sibling !== null) {
	                    if(!is_red(sibling.get_child(!last)) && !is_red(sibling.get_child(last))) {
	                        // color flip
	                        p.red = false;
	                        sibling.red = true;
	                        node.red = true;
	                    }
	                    else {
	                        var dir2 = gp.right === p;

	                        if(is_red(sibling.get_child(last))) {
	                            gp.set_child(dir2, double_rotate(p, last));
	                        }
	                        else if(is_red(sibling.get_child(!last))) {
	                            gp.set_child(dir2, single_rotate(p, last));
	                        }

	                        // ensure correct coloring
	                        var gpc = gp.get_child(dir2);
	                        gpc.red = true;
	                        node.red = true;
	                        gpc.left.red = false;
	                        gpc.right.red = false;
	                    }
	                }
	            }
	        }
	    }

	    // replace and remove if found
	    if(found !== null) {
	        found.data = node.data;
	        p.set_child(p.right === node, node.get_child(node.left === null));
	        this.size--;
	    }

	    // update root and make it black
	    this._root = head.right;
	    if(this._root !== null) {
	        this._root.red = false;
	    }

	    return found !== null;
	};

	function is_red(node) {
	    return node !== null && node.red;
	}

	function single_rotate(root, dir) {
	    var save = root.get_child(!dir);

	    root.set_child(!dir, save.get_child(dir));
	    save.set_child(dir, root);

	    root.red = true;
	    save.red = false;

	    return save;
	}

	function double_rotate(root, dir) {
	    root.set_child(!dir, single_rotate(root.get_child(!dir), !dir));
	    return single_rotate(root, dir);
	}

	rbtree = RBTree;
	return rbtree;
}

var bintree;
var hasRequiredBintree;

function requireBintree () {
	if (hasRequiredBintree) return bintree;
	hasRequiredBintree = 1;
	var TreeBase = requireTreebase();

	function Node(data) {
	    this.data = data;
	    this.left = null;
	    this.right = null;
	}

	Node.prototype.get_child = function(dir) {
	    return dir ? this.right : this.left;
	};

	Node.prototype.set_child = function(dir, val) {
	    if(dir) {
	        this.right = val;
	    }
	    else {
	        this.left = val;
	    }
	};

	function BinTree(comparator) {
	    this._root = null;
	    this._comparator = comparator;
	    this.size = 0;
	}

	BinTree.prototype = new TreeBase();

	// returns true if inserted, false if duplicate
	BinTree.prototype.insert = function(data) {
	    if(this._root === null) {
	        // empty tree
	        this._root = new Node(data);
	        this.size++;
	        return true;
	    }

	    var dir = 0;

	    // setup
	    var p = null; // parent
	    var node = this._root;

	    // search down
	    while(true) {
	        if(node === null) {
	            // insert new node at the bottom
	            node = new Node(data);
	            p.set_child(dir, node);
	            ret = true;
	            this.size++;
	            return true;
	        }

	        // stop if found
	        if(this._comparator(node.data, data) === 0) {
	            return false;
	        }

	        dir = this._comparator(node.data, data) < 0;

	        // update helpers
	        p = node;
	        node = node.get_child(dir);
	    }
	};

	// returns true if removed, false if not found
	BinTree.prototype.remove = function(data) {
	    if(this._root === null) {
	        return false;
	    }

	    var head = new Node(undefined); // fake tree root
	    var node = head;
	    node.right = this._root;
	    var p = null; // parent
	    var found = null; // found item
	    var dir = 1;

	    while(node.get_child(dir) !== null) {
	        p = node;
	        node = node.get_child(dir);
	        var cmp = this._comparator(data, node.data);
	        dir = cmp > 0;

	        if(cmp === 0) {
	            found = node;
	        }
	    }

	    if(found !== null) {
	        found.data = node.data;
	        p.set_child(p.right === node, node.get_child(node.left === null));

	        this._root = head.right;
	        this.size--;
	        return true;
	    }
	    else {
	        return false;
	    }
	};

	bintree = BinTree;
	return bintree;
}

var bintrees;
var hasRequiredBintrees;

function requireBintrees () {
	if (hasRequiredBintrees) return bintrees;
	hasRequiredBintrees = 1;
	bintrees = {
	    RBTree: requireRbtree(),
	    BinTree: requireBintree()
	};
	return bintrees;
}

var tdigest;
var hasRequiredTdigest;

function requireTdigest () {
	if (hasRequiredTdigest) return tdigest;
	hasRequiredTdigest = 1;
	//
	// TDigest:
	//
	// approximate distribution percentiles from a stream of reals
	//
	var RBTree = requireBintrees().RBTree;

	function TDigest(delta, K, CX) {
	    // allocate a TDigest structure.
	    //
	    // delta is the compression factor, the max fraction of mass that
	    // can be owned by one centroid (bigger, up to 1.0, means more
	    // compression). delta=false switches off TDigest behavior and treats
	    // the distribution as discrete, with no merging and exact values
	    // reported.
	    //
	    // K is a size threshold that triggers recompression as the TDigest
	    // grows during input.  (Set it to 0 to disable automatic recompression)
	    //
	    // CX specifies how often to update cached cumulative totals used
	    // for quantile estimation during ingest (see cumulate()).  Set to
	    // 0 to use exact quantiles for each new point.
	    //
	    this.discrete = (delta === false);
	    this.delta = delta || 0.01;
	    this.K = (K === undefined) ? 25 : K;
	    this.CX = (CX === undefined) ? 1.1 : CX;
	    this.centroids = new RBTree(compare_centroid_means);
	    this.nreset = 0;
	    this.reset();
	}

	TDigest.prototype.reset = function() {
	    // prepare to digest new points.
	    //
	    this.centroids.clear();
	    this.n = 0;
	    this.nreset += 1;
	    this.last_cumulate = 0;
	};

	TDigest.prototype.size = function() {
	    return this.centroids.size;
	};

	TDigest.prototype.toArray = function(everything) {
	    // return {mean,n} of centroids as an array ordered by mean.
	    //
	    var result = [];
	    if (everything) {
	        this._cumulate(true); // be sure cumns are exact
	        this.centroids.each(function(c) { result.push(c); });
	    } else {
	        this.centroids.each(function(c) { result.push({mean:c.mean, n:c.n}); });
	    }
	    return result;
	};

	TDigest.prototype.summary = function() {
	    var approx = (this.discrete) ? "exact " : "approximating ";
	    var s = [approx + this.n + " samples using " + this.size() + " centroids",
	             "min = "+this.percentile(0),
	             "Q1  = "+this.percentile(0.25),
	             "Q2  = "+this.percentile(0.5),
	             "Q3  = "+this.percentile(0.75),
	             "max = "+this.percentile(1.0)];
	    return s.join('\n');
	};

	function compare_centroid_means(a, b) {
	    // order two centroids by mean.
	    //
	    return (a.mean > b.mean) ? 1 : (a.mean < b.mean) ? -1 : 0;
	}

	function compare_centroid_mean_cumns(a, b) {
	    // order two centroids by mean_cumn.
	    //
	    return (a.mean_cumn - b.mean_cumn);
	}

	TDigest.prototype.push = function(x, n) {
	    // incorporate value or array of values x, having count n into the
	    // TDigest. n defaults to 1.
	    //
	    n = n || 1;
	    x = Array.isArray(x) ? x : [x];
	    for (var i = 0 ; i < x.length ; i++) {
	        this._digest(x[i], n);
	    }
	};

	TDigest.prototype.push_centroid = function(c) {
	    // incorporate centroid or array of centroids c
	    //
	    c = Array.isArray(c) ? c : [c];
	    for (var i = 0 ; i < c.length ; i++) {
	        this._digest(c[i].mean, c[i].n);
	    }
	};

	TDigest.prototype._cumulate = function(exact) {
	    // update cumulative counts for each centroid
	    //
	    // exact: falsey means only cumulate after sufficient
	    // growth. During ingest, these counts are used as quantile
	    // estimates, and they work well even when somewhat out of
	    // date. (this is a departure from the publication, you may set CX
	    // to 0 to disable).
	    //
	    if (this.n === this.last_cumulate ||
	        !exact && this.CX && this.CX > (this.n / this.last_cumulate)) {
	        return;
	    }
	    var cumn = 0;
	    this.centroids.each(function(c) {
	        c.mean_cumn = cumn + c.n / 2; // half of n at the mean
	        cumn = c.cumn = cumn + c.n;
	    });
	    this.n = this.last_cumulate = cumn;
	};

	TDigest.prototype.find_nearest = function(x) {
	    // find the centroid closest to x. The assumption of
	    // unique means and a unique nearest centroid departs from the
	    // paper, see _digest() below
	    //
	    if (this.size() === 0) {
	        return null;
	    }
	    var iter = this.centroids.lowerBound({mean:x}); // x <= iter || iter==null
	    var c = (iter.data() === null) ? iter.prev() : iter.data();
	    if (c.mean === x || this.discrete) {
	        return c; // c is either x or a neighbor (discrete: no distance func)
	    }
	    var prev = iter.prev();
	    if (prev && Math.abs(prev.mean - x) < Math.abs(c.mean - x)) {
	        return prev;
	    } else {
	        return c;
	    }
	};

	TDigest.prototype._new_centroid = function(x, n, cumn) {
	    // create and insert a new centroid into the digest (don't update
	    // cumulatives).
	    //
	    var c = {mean:x, n:n, cumn:cumn};
	    this.centroids.insert(c);
	    this.n += n;
	    return c;
	};

	TDigest.prototype._addweight = function(nearest, x, n) {
	    // add weight at location x to nearest centroid.  adding x to
	    // nearest will not shift its relative position in the tree and
	    // require reinsertion.
	    //
	    if (x !== nearest.mean) {
	        nearest.mean += n * (x - nearest.mean) / (nearest.n + n);
	    }
	    nearest.cumn += n;
	    nearest.mean_cumn += n / 2;
	    nearest.n += n;
	    this.n += n;
	};

	TDigest.prototype._digest = function(x, n) {
	    // incorporate value x, having count n into the TDigest.
	    //
	    var min = this.centroids.min();
	    var max = this.centroids.max();
	    var nearest = this.find_nearest(x);
	    if (nearest && nearest.mean === x) {
	        // accumulate exact matches into the centroid without
	        // limit. this is a departure from the paper, made so
	        // centroids remain unique and code can be simple.
	        this._addweight(nearest, x, n);
	    } else if (nearest === min) {
	        this._new_centroid(x, n, 0); // new point around min boundary
	    } else if (nearest === max ) {
	        this._new_centroid(x, n, this.n); // new point around max boundary
	    } else if (this.discrete) {
	        this._new_centroid(x, n, nearest.cumn); // never merge
	    } else {
	        // conider a merge based on nearest centroid's capacity. if
	        // there's not room for all of n, don't bother merging any of
	        // it into nearest, as we'll have to make a new centroid
	        // anyway for the remainder (departure from the paper).
	        var p = nearest.mean_cumn / this.n;
	        var max_n = Math.floor(4 * this.n * this.delta * p * (1 - p));
	        if (max_n - nearest.n >= n) {
	            this._addweight(nearest, x, n);
	        } else {
	            this._new_centroid(x, n, nearest.cumn);
	        }
	    }
	    this._cumulate(false);
	    if (!this.discrete && this.K && this.size() > this.K / this.delta) {
	        // re-process the centroids and hope for some compression.
	        this.compress();
	    }
	};

	TDigest.prototype.bound_mean = function(x) {
	    // find centroids lower and upper such that lower.mean < x <
	    // upper.mean or lower.mean === x === upper.mean. Don't call
	    // this for x out of bounds.
	    //
	    var iter = this.centroids.upperBound({mean:x}); // x < iter
	    var lower = iter.prev();      // lower <= x
	    var upper = (lower.mean === x) ? lower : iter.next();
	    return [lower, upper];
	};

	TDigest.prototype.p_rank = function(x_or_xlist) {
	    // return approximate percentile-ranks (0..1) for data value x.
	    // or list of x.  calculated according to
	    // https://en.wikipedia.org/wiki/Percentile_rank
	    //
	    // (Note that in continuous mode, boundary sample values will
	    // report half their centroid weight inward from 0/1 as the
	    // percentile-rank. X values outside the observed range return
	    // 0/1)
	    //
	    // this triggers cumulate() if cumn's are out of date.
	    //
	    var xs = Array.isArray(x_or_xlist) ? x_or_xlist : [x_or_xlist];
	    var ps = xs.map(this._p_rank, this);
	    return Array.isArray(x_or_xlist) ? ps : ps[0];
	};

	TDigest.prototype._p_rank = function(x) {
	    if (this.size() === 0) {
	        return undefined;
	    } else if (x < this.centroids.min().mean) {
	        return 0.0;
	    } else if (x > this.centroids.max().mean) {
	        return 1.0;
	    }
	    // find centroids that bracket x and interpolate x's cumn from
	    // their cumn's.
	    this._cumulate(true); // be sure cumns are exact
	    var bound = this.bound_mean(x);
	    var lower = bound[0], upper = bound[1];
	    if (this.discrete) {
	        return lower.cumn / this.n;
	    } else {
	        var cumn = lower.mean_cumn;
	        if (lower !== upper) {
	            cumn += (x - lower.mean) * (upper.mean_cumn - lower.mean_cumn) / (upper.mean - lower.mean);
	        }
	        return cumn / this.n;
	    }
	};

	TDigest.prototype.bound_mean_cumn = function(cumn) {
	    // find centroids lower and upper such that lower.mean_cumn < x <
	    // upper.mean_cumn or lower.mean_cumn === x === upper.mean_cumn. Don't call
	    // this for cumn out of bounds.
	    //
	    // XXX because mean and mean_cumn give rise to the same sort order
	    // (up to identical means), use the mean rbtree for our search.
	    this.centroids._comparator = compare_centroid_mean_cumns;
	    var iter = this.centroids.upperBound({mean_cumn:cumn}); // cumn < iter
	    this.centroids._comparator = compare_centroid_means;
	    var lower = iter.prev();      // lower <= cumn
	    var upper = (lower && lower.mean_cumn === cumn) ? lower : iter.next();
	    return [lower, upper];
	};

	TDigest.prototype.percentile = function(p_or_plist) {
	    // for percentage p (0..1), or for each p in a list of ps, return
	    // the smallest data value q at which at least p percent of the
	    // observations <= q.
	    //
	    // for discrete distributions, this selects q using the Nearest
	    // Rank Method
	    // (https://en.wikipedia.org/wiki/Percentile#The_Nearest_Rank_method)
	    // (in scipy, same as percentile(...., interpolation='higher')
	    //
	    // for continuous distributions, interpolates data values between
	    // count-weighted bracketing means.
	    //
	    // this triggers cumulate() if cumn's are out of date.
	    //
	    var ps = Array.isArray(p_or_plist) ? p_or_plist : [p_or_plist];
	    var qs = ps.map(this._percentile, this);
	    return Array.isArray(p_or_plist) ? qs : qs[0];
	};

	TDigest.prototype._percentile = function(p) {
	    if (this.size() === 0) {
	        return undefined;
	    }
	    this._cumulate(true); // be sure cumns are exact
	    var h = this.n * p;
	    var bound = this.bound_mean_cumn(h);
	    var lower = bound[0], upper = bound[1];

	    if (upper === lower || lower === null || upper === null) {
	        return (lower || upper).mean;
	    } else if (!this.discrete) {
	        return lower.mean + (h - lower.mean_cumn) * (upper.mean - lower.mean) / (upper.mean_cumn - lower.mean_cumn);
	    } else if (h <= lower.cumn) {
	        return lower.mean;
	    } else {
	        return upper.mean;
	    }
	};

	function pop_random(choices) {
	    // remove and return an item randomly chosen from the array of choices
	    // (mutates choices)
	    //
	    var idx = Math.floor(Math.random() * choices.length);
	    return choices.splice(idx, 1)[0];
	}

	TDigest.prototype.compress = function() {
	    // TDigests experience worst case compression (none) when input
	    // increases monotonically.  Improve on any bad luck by
	    // reconsuming digest centroids as if they were weighted points
	    // while shuffling their order (and hope for the best).
	    //
	    if (this.compressing) {
	        return;
	    }
	    var points = this.toArray();
	    this.reset();
	    this.compressing = true;
	    while (points.length > 0) {
	        this.push_centroid(pop_random(points));
	    }
	    this._cumulate(true);
	    this.compressing = false;
	};

	function Digest(config) {
	    // allocate a distribution digest structure. This is an extension
	    // of a TDigest structure that starts in exact histogram (discrete)
	    // mode, and automatically switches to TDigest mode for large
	    // samples that appear to be from a continuous distribution.
	    //
	    this.config = config || {};
	    this.mode = this.config.mode || 'auto'; // disc, cont, auto
	    TDigest.call(this, this.mode === 'cont' ? config.delta : false);
	    this.digest_ratio = this.config.ratio || 0.9;
	    this.digest_thresh = this.config.thresh || 1000;
	    this.n_unique = 0;
	}
	Digest.prototype = Object.create(TDigest.prototype);
	Digest.prototype.constructor = Digest;

	Digest.prototype.push = function(x_or_xlist) {
	    TDigest.prototype.push.call(this, x_or_xlist);
	    this.check_continuous();
	};

	Digest.prototype._new_centroid = function(x, n, cumn) {
	    this.n_unique += 1;
	    TDigest.prototype._new_centroid.call(this, x, n, cumn);
	};

	Digest.prototype._addweight = function(nearest, x, n) {
	    if (nearest.n === 1) {
	        this.n_unique -= 1;
	    }
	    TDigest.prototype._addweight.call(this, nearest, x, n);
	};

	Digest.prototype.check_continuous = function() {
	    // while in 'auto' mode, if there are many unique elements, assume
	    // they are from a continuous distribution and switch to 'cont'
	    // mode (tdigest behavior). Return true on transition from
	    // disctete to continuous.
	    if (this.mode !== 'auto' || this.size() < this.digest_thresh) {
	        return false;
	    }
	    if (this.n_unique / this.size() > this.digest_ratio) {
	        this.mode = 'cont';
	        this.discrete = false;
	        this.delta = this.config.delta || 0.01;
	        this.compress();
	        return true;
	    }
	    return false;
	};

	tdigest = {
	    'TDigest': TDigest,
	    'Digest': Digest
	};
	return tdigest;
}

var timeWindowQuantiles;
var hasRequiredTimeWindowQuantiles;

function requireTimeWindowQuantiles () {
	if (hasRequiredTimeWindowQuantiles) return timeWindowQuantiles;
	hasRequiredTimeWindowQuantiles = 1;

	const { TDigest } = requireTdigest();

	class TimeWindowQuantiles {
		constructor(maxAgeSeconds, ageBuckets) {
			this.maxAgeSeconds = maxAgeSeconds || 0;
			this.ageBuckets = ageBuckets || 0;

			this.shouldRotate = maxAgeSeconds && ageBuckets;

			this.ringBuffer = Array(ageBuckets).fill(new TDigest());
			this.currentBuffer = 0;

			this.lastRotateTimestampMillis = Date.now();
			this.durationBetweenRotatesMillis =
				(maxAgeSeconds * 1000) / ageBuckets || Infinity;
		}

		size() {
			const bucket = rotate.call(this);
			return bucket.size();
		}

		percentile(quantile) {
			const bucket = rotate.call(this);
			return bucket.percentile(quantile);
		}

		push(value) {
			rotate.call(this);
			this.ringBuffer.forEach(bucket => {
				bucket.push(value);
			});
		}

		reset() {
			this.ringBuffer.forEach(bucket => {
				bucket.reset();
			});
		}

		compress() {
			this.ringBuffer.forEach(bucket => {
				bucket.compress();
			});
		}
	}

	function rotate() {
		let timeSinceLastRotateMillis = Date.now() - this.lastRotateTimestampMillis;
		while (
			timeSinceLastRotateMillis > this.durationBetweenRotatesMillis &&
			this.shouldRotate
		) {
			this.ringBuffer[this.currentBuffer] = new TDigest();

			if (++this.currentBuffer >= this.ringBuffer.length) {
				this.currentBuffer = 0;
			}
			timeSinceLastRotateMillis -= this.durationBetweenRotatesMillis;
			this.lastRotateTimestampMillis += this.durationBetweenRotatesMillis;
		}
		return this.ringBuffer[this.currentBuffer];
	}

	timeWindowQuantiles = TimeWindowQuantiles;
	return timeWindowQuantiles;
}

/**
 * Summary
 */

var summary;
var hasRequiredSummary;

function requireSummary () {
	if (hasRequiredSummary) return summary;
	hasRequiredSummary = 1;

	const util = require$$0$1;
	const { getLabels, hashObject, removeLabels } = requireUtil();
	const { validateLabel } = requireValidation();
	const { Metric } = requireMetric();
	const timeWindowQuantiles = requireTimeWindowQuantiles();

	const DEFAULT_COMPRESS_COUNT = 1000; // every 1000 measurements

	class Summary extends Metric {
		constructor(config) {
			super(config, {
				percentiles: [0.01, 0.05, 0.5, 0.9, 0.95, 0.99, 0.999],
				compressCount: DEFAULT_COMPRESS_COUNT,
				hashMap: {},
			});

			this.type = 'summary';

			for (const label of this.labelNames) {
				if (label === 'quantile')
					throw new Error('quantile is a reserved label keyword');
			}

			if (this.labelNames.length === 0) {
				this.hashMap = {
					[hashObject({})]: {
						labels: {},
						td: new timeWindowQuantiles(this.maxAgeSeconds, this.ageBuckets),
						count: 0,
						sum: 0,
					},
				};
			}
		}

		/**
		 * Observe a value
		 * @param {object} labels - Object with labels where key is the label key and value is label value. Can only be one level deep
		 * @param {Number} value - Value to observe
		 * @returns {void}
		 */
		observe(labels, value) {
			observe.call(this, labels === 0 ? 0 : labels || {})(value);
		}

		async get() {
			if (this.collect) {
				const v = this.collect();
				if (v instanceof Promise) await v;
			}
			const hashKeys = Object.keys(this.hashMap);
			const values = [];

			hashKeys.forEach(hashKey => {
				const s = this.hashMap[hashKey];
				if (s) {
					if (this.pruneAgedBuckets && s.td.size() === 0) {
						delete this.hashMap[hashKey];
					} else {
						extractSummariesForExport(s, this.percentiles).forEach(v => {
							values.push(v);
						});
						values.push(getSumForExport(s, this));
						values.push(getCountForExport(s, this));
					}
				}
			});

			return {
				name: this.name,
				help: this.help,
				type: this.type,
				values,
				aggregator: this.aggregator,
			};
		}

		reset() {
			const data = Object.values(this.hashMap);
			data.forEach(s => {
				s.td.reset();
				s.count = 0;
				s.sum = 0;
			});
		}

		/**
		 * Start a timer that could be used to logging durations
		 * @param {object} labels - Object with labels where key is the label key and value is label value. Can only be one level deep
		 * @returns {function} - Function to invoke when you want to stop the timer and observe the duration in seconds
		 * @example
		 * var end = summary.startTimer();
		 * makeExpensiveXHRRequest(function(err, res) {
		 *	end(); //Observe the duration of expensiveXHRRequest
		 * });
		 */
		startTimer(labels) {
			return startTimer.call(this, labels)();
		}

		labels(...args) {
			const labels = getLabels(this.labelNames, args);
			validateLabel(this.labelNames, labels);
			return {
				observe: observe.call(this, labels),
				startTimer: startTimer.call(this, labels),
			};
		}

		remove(...args) {
			const labels = getLabels(this.labelNames, args);
			validateLabel(this.labelNames, labels);
			removeLabels.call(this, this.hashMap, labels, this.sortedLabelNames);
		}
	}

	function extractSummariesForExport(summaryOfLabels, percentiles) {
		summaryOfLabels.td.compress();

		return percentiles.map(percentile => {
			const percentileValue = summaryOfLabels.td.percentile(percentile);
			return {
				labels: Object.assign({ quantile: percentile }, summaryOfLabels.labels),
				value: percentileValue ? percentileValue : 0,
			};
		});
	}

	function getCountForExport(value, summary) {
		return {
			metricName: `${summary.name}_count`,
			labels: value.labels,
			value: value.count,
		};
	}

	function getSumForExport(value, summary) {
		return {
			metricName: `${summary.name}_sum`,
			labels: value.labels,
			value: value.sum,
		};
	}

	function startTimer(startLabels) {
		return () => {
			const start = process.hrtime();
			return endLabels => {
				const delta = process.hrtime(start);
				const value = delta[0] + delta[1] / 1e9;
				this.observe(Object.assign({}, startLabels, endLabels), value);
				return value;
			};
		};
	}

	function observe(labels) {
		return value => {
			const labelValuePair = convertLabelsAndValues(labels, value);

			validateLabel(this.labelNames, labels);
			if (!Number.isFinite(labelValuePair.value)) {
				throw new TypeError(
					`Value is not a valid number: ${util.format(labelValuePair.value)}`,
				);
			}

			const hash = hashObject(labelValuePair.labels, this.sortedLabelNames);
			let summaryOfLabel = this.hashMap[hash];
			if (!summaryOfLabel) {
				summaryOfLabel = {
					labels: labelValuePair.labels,
					td: new timeWindowQuantiles(this.maxAgeSeconds, this.ageBuckets),
					count: 0,
					sum: 0,
				};
			}

			summaryOfLabel.td.push(labelValuePair.value);
			summaryOfLabel.count++;
			if (summaryOfLabel.count % this.compressCount === 0) {
				summaryOfLabel.td.compress();
			}
			summaryOfLabel.sum += labelValuePair.value;
			this.hashMap[hash] = summaryOfLabel;
		};
	}

	function convertLabelsAndValues(labels, value) {
		if (value === undefined) {
			return {
				value: labels,
				labels: {},
			};
		}

		return {
			labels,
			value,
		};
	}

	summary = Summary;
	return summary;
}

var pushgateway;
var hasRequiredPushgateway;

function requirePushgateway () {
	if (hasRequiredPushgateway) return pushgateway;
	hasRequiredPushgateway = 1;

	const url = require$$0$2;
	const http = require$$1;
	const https = require$$2;
	const { gzipSync } = require$$3;
	const { globalRegistry } = requireRegistry();

	class Pushgateway {
		constructor(gatewayUrl, options, registry) {
			if (!registry) {
				registry = globalRegistry;
			}
			this.registry = registry;
			this.gatewayUrl = gatewayUrl;
			const { requireJobName, ...requestOptions } = {
				requireJobName: true,
				...options,
			};
			this.requireJobName = requireJobName;
			this.requestOptions = requestOptions;
		}

		pushAdd(params = {}) {
			if (this.requireJobName && !params.jobName) {
				throw new Error('Missing jobName parameter');
			}

			return useGateway.call(this, 'POST', params.jobName, params.groupings);
		}

		push(params = {}) {
			if (this.requireJobName && !params.jobName) {
				throw new Error('Missing jobName parameter');
			}

			return useGateway.call(this, 'PUT', params.jobName, params.groupings);
		}

		delete(params = {}) {
			if (this.requireJobName && !params.jobName) {
				throw new Error('Missing jobName parameter');
			}

			return useGateway.call(this, 'DELETE', params.jobName, params.groupings);
		}
	}
	async function useGateway(method, job, groupings) {
		// `URL` first added in v6.13.0
		// eslint-disable-next-line n/no-deprecated-api
		const gatewayUrlParsed = url.parse(this.gatewayUrl);
		const gatewayUrlPath =
			gatewayUrlParsed.pathname && gatewayUrlParsed.pathname !== '/'
				? gatewayUrlParsed.pathname
				: '';
		const jobPath = job
			? `/job/${encodeURIComponent(job)}${generateGroupings(groupings)}`
			: '';
		const path = `${gatewayUrlPath}/metrics${jobPath}`;

		// eslint-disable-next-line n/no-deprecated-api
		const target = url.resolve(this.gatewayUrl, path);
		// eslint-disable-next-line n/no-deprecated-api
		const requestParams = url.parse(target);
		const httpModule = isHttps(requestParams.href) ? https : http;
		const options = Object.assign(requestParams, this.requestOptions, {
			method,
		});

		return new Promise((resolve, reject) => {
			if (method === 'DELETE' && options.headers) {
				delete options.headers['Content-Encoding'];
			}
			const req = httpModule.request(options, resp => {
				let body = '';
				resp.setEncoding('utf8');
				resp.on('data', chunk => {
					body += chunk;
				});
				resp.on('end', () => {
					if (resp.statusCode >= 400) {
						reject(
							new Error(`push failed with status ${resp.statusCode}, ${body}`),
						);
					} else {
						resolve({ resp, body });
					}
				});
			});
			req.on('error', err => {
				reject(err);
			});

			req.on('timeout', () => {
				req.destroy(new Error('Pushgateway request timed out'));
			});

			if (method !== 'DELETE') {
				this.registry
					.metrics()
					.then(metrics => {
						if (
							options.headers &&
							options.headers['Content-Encoding'] === 'gzip'
						) {
							metrics = gzipSync(metrics);
						}
						req.write(metrics);
						req.end();
					})
					.catch(err => {
						reject(err);
					});
			} else {
				req.end();
			}
		});
	}

	function generateGroupings(groupings) {
		if (!groupings) {
			return '';
		}
		return Object.keys(groupings)
			.map(
				key =>
					`/${encodeURIComponent(key)}/${encodeURIComponent(groupings[key])}`,
			)
			.join('');
	}

	function isHttps(href) {
		return href.search(/^https/) !== -1;
	}

	pushgateway = Pushgateway;
	return pushgateway;
}

var bucketGenerators = {};

var hasRequiredBucketGenerators;

function requireBucketGenerators () {
	if (hasRequiredBucketGenerators) return bucketGenerators;
	hasRequiredBucketGenerators = 1;

	bucketGenerators.linearBuckets = (start, width, count) => {
		if (count < 1) {
			throw new Error('Linear buckets needs a positive count');
		}

		const buckets = new Array(count);
		for (let i = 0; i < count; i++) {
			buckets[i] = start + i * width;
		}
		return buckets;
	};

	bucketGenerators.exponentialBuckets = (start, factor, count) => {
		if (start <= 0) {
			throw new Error('Exponential buckets needs a positive start');
		}
		if (count < 1) {
			throw new Error('Exponential buckets needs a positive count');
		}
		if (factor <= 1) {
			throw new Error('Exponential buckets needs a factor greater than 1');
		}
		const buckets = new Array(count);
		for (let i = 0; i < count; i++) {
			buckets[i] = start;
			start *= factor;
		}
		return buckets;
	};
	return bucketGenerators;
}

var defaultMetrics = {exports: {}};

var processCpuTotal = {exports: {}};

/*
 * Copyright The OpenTelemetry Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
/** only globals that common to node and browsers are allowed */
// eslint-disable-next-line node/no-unsupported-features/es-builtins
var _globalThis = typeof globalThis === 'object' ? globalThis : global;

/*
 * Copyright The OpenTelemetry Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
// this is autogenerated file, see scripts/version-update.js
var VERSION = '1.9.0';

/*
 * Copyright The OpenTelemetry Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
var re = /^(\d+)\.(\d+)\.(\d+)(-(.+))?$/;
/**
 * Create a function to test an API version to see if it is compatible with the provided ownVersion.
 *
 * The returned function has the following semantics:
 * - Exact match is always compatible
 * - Major versions must match exactly
 *    - 1.x package cannot use global 2.x package
 *    - 2.x package cannot use global 1.x package
 * - The minor version of the API module requesting access to the global API must be less than or equal to the minor version of this API
 *    - 1.3 package may use 1.4 global because the later global contains all functions 1.3 expects
 *    - 1.4 package may NOT use 1.3 global because it may try to call functions which don't exist on 1.3
 * - If the major version is 0, the minor version is treated as the major and the patch is treated as the minor
 * - Patch and build tag differences are not considered at this time
 *
 * @param ownVersion version which should be checked against
 */
function _makeCompatibilityCheck(ownVersion) {
    var acceptedVersions = new Set([ownVersion]);
    var rejectedVersions = new Set();
    var myVersionMatch = ownVersion.match(re);
    if (!myVersionMatch) {
        // we cannot guarantee compatibility so we always return noop
        return function () { return false; };
    }
    var ownVersionParsed = {
        major: +myVersionMatch[1],
        minor: +myVersionMatch[2],
        patch: +myVersionMatch[3],
        prerelease: myVersionMatch[4],
    };
    // if ownVersion has a prerelease tag, versions must match exactly
    if (ownVersionParsed.prerelease != null) {
        return function isExactmatch(globalVersion) {
            return globalVersion === ownVersion;
        };
    }
    function _reject(v) {
        rejectedVersions.add(v);
        return false;
    }
    function _accept(v) {
        acceptedVersions.add(v);
        return true;
    }
    return function isCompatible(globalVersion) {
        if (acceptedVersions.has(globalVersion)) {
            return true;
        }
        if (rejectedVersions.has(globalVersion)) {
            return false;
        }
        var globalVersionMatch = globalVersion.match(re);
        if (!globalVersionMatch) {
            // cannot parse other version
            // we cannot guarantee compatibility so we always noop
            return _reject(globalVersion);
        }
        var globalVersionParsed = {
            major: +globalVersionMatch[1],
            minor: +globalVersionMatch[2],
            patch: +globalVersionMatch[3],
            prerelease: globalVersionMatch[4],
        };
        // if globalVersion has a prerelease tag, versions must match exactly
        if (globalVersionParsed.prerelease != null) {
            return _reject(globalVersion);
        }
        // major versions must match
        if (ownVersionParsed.major !== globalVersionParsed.major) {
            return _reject(globalVersion);
        }
        if (ownVersionParsed.major === 0) {
            if (ownVersionParsed.minor === globalVersionParsed.minor &&
                ownVersionParsed.patch <= globalVersionParsed.patch) {
                return _accept(globalVersion);
            }
            return _reject(globalVersion);
        }
        if (ownVersionParsed.minor <= globalVersionParsed.minor) {
            return _accept(globalVersion);
        }
        return _reject(globalVersion);
    };
}
/**
 * Test an API version to see if it is compatible with this API.
 *
 * - Exact match is always compatible
 * - Major versions must match exactly
 *    - 1.x package cannot use global 2.x package
 *    - 2.x package cannot use global 1.x package
 * - The minor version of the API module requesting access to the global API must be less than or equal to the minor version of this API
 *    - 1.3 package may use 1.4 global because the later global contains all functions 1.3 expects
 *    - 1.4 package may NOT use 1.3 global because it may try to call functions which don't exist on 1.3
 * - If the major version is 0, the minor version is treated as the major and the patch is treated as the minor
 * - Patch and build tag differences are not considered at this time
 *
 * @param version version of the API requesting an instance of the global API
 */
var isCompatible = _makeCompatibilityCheck(VERSION);

/*
 * Copyright The OpenTelemetry Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
var major = VERSION.split('.')[0];
var GLOBAL_OPENTELEMETRY_API_KEY = Symbol.for("opentelemetry.js.api." + major);
var _global = _globalThis;
function registerGlobal(type, instance, diag, allowOverride) {
    var _a;
    if (allowOverride === void 0) { allowOverride = false; }
    var api = (_global[GLOBAL_OPENTELEMETRY_API_KEY] = (_a = _global[GLOBAL_OPENTELEMETRY_API_KEY]) !== null && _a !== void 0 ? _a : {
        version: VERSION,
    });
    if (!allowOverride && api[type]) {
        // already registered an API of this type
        var err = new Error("@opentelemetry/api: Attempted duplicate registration of API: " + type);
        diag.error(err.stack || err.message);
        return false;
    }
    if (api.version !== VERSION) {
        // All registered APIs must be of the same version exactly
        var err = new Error("@opentelemetry/api: Registration of version v" + api.version + " for " + type + " does not match previously registered API v" + VERSION);
        diag.error(err.stack || err.message);
        return false;
    }
    api[type] = instance;
    diag.debug("@opentelemetry/api: Registered a global for " + type + " v" + VERSION + ".");
    return true;
}
function getGlobal(type) {
    var _a, _b;
    var globalVersion = (_a = _global[GLOBAL_OPENTELEMETRY_API_KEY]) === null || _a === void 0 ? void 0 : _a.version;
    if (!globalVersion || !isCompatible(globalVersion)) {
        return;
    }
    return (_b = _global[GLOBAL_OPENTELEMETRY_API_KEY]) === null || _b === void 0 ? void 0 : _b[type];
}
function unregisterGlobal(type, diag) {
    diag.debug("@opentelemetry/api: Unregistering a global for " + type + " v" + VERSION + ".");
    var api = _global[GLOBAL_OPENTELEMETRY_API_KEY];
    if (api) {
        delete api[type];
    }
}

/*
 * Copyright The OpenTelemetry Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
var __read$4 = (undefined && undefined.__read) || function (o, n) {
    var m = typeof Symbol === "function" && o[Symbol.iterator];
    if (!m) return o;
    var i = m.call(o), r, ar = [], e;
    try {
        while ((n === void 0 || n-- > 0) && !(r = i.next()).done) ar.push(r.value);
    }
    catch (error) { e = { error: error }; }
    finally {
        try {
            if (r && !r.done && (m = i["return"])) m.call(i);
        }
        finally { if (e) throw e.error; }
    }
    return ar;
};
var __spreadArray$3 = (undefined && undefined.__spreadArray) || function (to, from, pack) {
    if (pack || arguments.length === 2) for (var i = 0, l = from.length, ar; i < l; i++) {
        if (ar || !(i in from)) {
            if (!ar) ar = Array.prototype.slice.call(from, 0, i);
            ar[i] = from[i];
        }
    }
    return to.concat(ar || Array.prototype.slice.call(from));
};
/**
 * Component Logger which is meant to be used as part of any component which
 * will add automatically additional namespace in front of the log message.
 * It will then forward all message to global diag logger
 * @example
 * const cLogger = diag.createComponentLogger({ namespace: '@opentelemetry/instrumentation-http' });
 * cLogger.debug('test');
 * // @opentelemetry/instrumentation-http test
 */
var DiagComponentLogger = /** @class */ (function () {
    function DiagComponentLogger(props) {
        this._namespace = props.namespace || 'DiagComponentLogger';
    }
    DiagComponentLogger.prototype.debug = function () {
        var args = [];
        for (var _i = 0; _i < arguments.length; _i++) {
            args[_i] = arguments[_i];
        }
        return logProxy('debug', this._namespace, args);
    };
    DiagComponentLogger.prototype.error = function () {
        var args = [];
        for (var _i = 0; _i < arguments.length; _i++) {
            args[_i] = arguments[_i];
        }
        return logProxy('error', this._namespace, args);
    };
    DiagComponentLogger.prototype.info = function () {
        var args = [];
        for (var _i = 0; _i < arguments.length; _i++) {
            args[_i] = arguments[_i];
        }
        return logProxy('info', this._namespace, args);
    };
    DiagComponentLogger.prototype.warn = function () {
        var args = [];
        for (var _i = 0; _i < arguments.length; _i++) {
            args[_i] = arguments[_i];
        }
        return logProxy('warn', this._namespace, args);
    };
    DiagComponentLogger.prototype.verbose = function () {
        var args = [];
        for (var _i = 0; _i < arguments.length; _i++) {
            args[_i] = arguments[_i];
        }
        return logProxy('verbose', this._namespace, args);
    };
    return DiagComponentLogger;
}());
function logProxy(funcName, namespace, args) {
    var logger = getGlobal('diag');
    // shortcut if logger not set
    if (!logger) {
        return;
    }
    args.unshift(namespace);
    return logger[funcName].apply(logger, __spreadArray$3([], __read$4(args), false));
}

/*
 * Copyright The OpenTelemetry Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
/**
 * Defines the available internal logging levels for the diagnostic logger, the numeric values
 * of the levels are defined to match the original values from the initial LogLevel to avoid
 * compatibility/migration issues for any implementation that assume the numeric ordering.
 */
var DiagLogLevel;
(function (DiagLogLevel) {
    /** Diagnostic Logging level setting to disable all logging (except and forced logs) */
    DiagLogLevel[DiagLogLevel["NONE"] = 0] = "NONE";
    /** Identifies an error scenario */
    DiagLogLevel[DiagLogLevel["ERROR"] = 30] = "ERROR";
    /** Identifies a warning scenario */
    DiagLogLevel[DiagLogLevel["WARN"] = 50] = "WARN";
    /** General informational log message */
    DiagLogLevel[DiagLogLevel["INFO"] = 60] = "INFO";
    /** General debug log message */
    DiagLogLevel[DiagLogLevel["DEBUG"] = 70] = "DEBUG";
    /**
     * Detailed trace level logging should only be used for development, should only be set
     * in a development environment.
     */
    DiagLogLevel[DiagLogLevel["VERBOSE"] = 80] = "VERBOSE";
    /** Used to set the logging level to include all logging */
    DiagLogLevel[DiagLogLevel["ALL"] = 9999] = "ALL";
})(DiagLogLevel || (DiagLogLevel = {}));

/*
 * Copyright The OpenTelemetry Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
function createLogLevelDiagLogger(maxLevel, logger) {
    if (maxLevel < DiagLogLevel.NONE) {
        maxLevel = DiagLogLevel.NONE;
    }
    else if (maxLevel > DiagLogLevel.ALL) {
        maxLevel = DiagLogLevel.ALL;
    }
    // In case the logger is null or undefined
    logger = logger || {};
    function _filterFunc(funcName, theLevel) {
        var theFunc = logger[funcName];
        if (typeof theFunc === 'function' && maxLevel >= theLevel) {
            return theFunc.bind(logger);
        }
        return function () { };
    }
    return {
        error: _filterFunc('error', DiagLogLevel.ERROR),
        warn: _filterFunc('warn', DiagLogLevel.WARN),
        info: _filterFunc('info', DiagLogLevel.INFO),
        debug: _filterFunc('debug', DiagLogLevel.DEBUG),
        verbose: _filterFunc('verbose', DiagLogLevel.VERBOSE),
    };
}

/*
 * Copyright The OpenTelemetry Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
var __read$3 = (undefined && undefined.__read) || function (o, n) {
    var m = typeof Symbol === "function" && o[Symbol.iterator];
    if (!m) return o;
    var i = m.call(o), r, ar = [], e;
    try {
        while ((n === void 0 || n-- > 0) && !(r = i.next()).done) ar.push(r.value);
    }
    catch (error) { e = { error: error }; }
    finally {
        try {
            if (r && !r.done && (m = i["return"])) m.call(i);
        }
        finally { if (e) throw e.error; }
    }
    return ar;
};
var __spreadArray$2 = (undefined && undefined.__spreadArray) || function (to, from, pack) {
    if (pack || arguments.length === 2) for (var i = 0, l = from.length, ar; i < l; i++) {
        if (ar || !(i in from)) {
            if (!ar) ar = Array.prototype.slice.call(from, 0, i);
            ar[i] = from[i];
        }
    }
    return to.concat(ar || Array.prototype.slice.call(from));
};
var API_NAME$4 = 'diag';
/**
 * Singleton object which represents the entry point to the OpenTelemetry internal
 * diagnostic API
 */
var DiagAPI = /** @class */ (function () {
    /**
     * Private internal constructor
     * @private
     */
    function DiagAPI() {
        function _logProxy(funcName) {
            return function () {
                var args = [];
                for (var _i = 0; _i < arguments.length; _i++) {
                    args[_i] = arguments[_i];
                }
                var logger = getGlobal('diag');
                // shortcut if logger not set
                if (!logger)
                    return;
                return logger[funcName].apply(logger, __spreadArray$2([], __read$3(args), false));
            };
        }
        // Using self local variable for minification purposes as 'this' cannot be minified
        var self = this;
        // DiagAPI specific functions
        var setLogger = function (logger, optionsOrLogLevel) {
            var _a, _b, _c;
            if (optionsOrLogLevel === void 0) { optionsOrLogLevel = { logLevel: DiagLogLevel.INFO }; }
            if (logger === self) {
                // There isn't much we can do here.
                // Logging to the console might break the user application.
                // Try to log to self. If a logger was previously registered it will receive the log.
                var err = new Error('Cannot use diag as the logger for itself. Please use a DiagLogger implementation like ConsoleDiagLogger or a custom implementation');
                self.error((_a = err.stack) !== null && _a !== void 0 ? _a : err.message);
                return false;
            }
            if (typeof optionsOrLogLevel === 'number') {
                optionsOrLogLevel = {
                    logLevel: optionsOrLogLevel,
                };
            }
            var oldLogger = getGlobal('diag');
            var newLogger = createLogLevelDiagLogger((_b = optionsOrLogLevel.logLevel) !== null && _b !== void 0 ? _b : DiagLogLevel.INFO, logger);
            // There already is an logger registered. We'll let it know before overwriting it.
            if (oldLogger && !optionsOrLogLevel.suppressOverrideMessage) {
                var stack = (_c = new Error().stack) !== null && _c !== void 0 ? _c : '<failed to generate stacktrace>';
                oldLogger.warn("Current logger will be overwritten from " + stack);
                newLogger.warn("Current logger will overwrite one already registered from " + stack);
            }
            return registerGlobal('diag', newLogger, self, true);
        };
        self.setLogger = setLogger;
        self.disable = function () {
            unregisterGlobal(API_NAME$4, self);
        };
        self.createComponentLogger = function (options) {
            return new DiagComponentLogger(options);
        };
        self.verbose = _logProxy('verbose');
        self.debug = _logProxy('debug');
        self.info = _logProxy('info');
        self.warn = _logProxy('warn');
        self.error = _logProxy('error');
    }
    /** Get the singleton instance of the DiagAPI API */
    DiagAPI.instance = function () {
        if (!this._instance) {
            this._instance = new DiagAPI();
        }
        return this._instance;
    };
    return DiagAPI;
}());

/*
 * Copyright The OpenTelemetry Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
var __read$2 = (undefined && undefined.__read) || function (o, n) {
    var m = typeof Symbol === "function" && o[Symbol.iterator];
    if (!m) return o;
    var i = m.call(o), r, ar = [], e;
    try {
        while ((n === void 0 || n-- > 0) && !(r = i.next()).done) ar.push(r.value);
    }
    catch (error) { e = { error: error }; }
    finally {
        try {
            if (r && !r.done && (m = i["return"])) m.call(i);
        }
        finally { if (e) throw e.error; }
    }
    return ar;
};
var __values = (undefined && undefined.__values) || function(o) {
    var s = typeof Symbol === "function" && Symbol.iterator, m = s && o[s], i = 0;
    if (m) return m.call(o);
    if (o && typeof o.length === "number") return {
        next: function () {
            if (o && i >= o.length) o = void 0;
            return { value: o && o[i++], done: !o };
        }
    };
    throw new TypeError(s ? "Object is not iterable." : "Symbol.iterator is not defined.");
};
var BaggageImpl = /** @class */ (function () {
    function BaggageImpl(entries) {
        this._entries = entries ? new Map(entries) : new Map();
    }
    BaggageImpl.prototype.getEntry = function (key) {
        var entry = this._entries.get(key);
        if (!entry) {
            return undefined;
        }
        return Object.assign({}, entry);
    };
    BaggageImpl.prototype.getAllEntries = function () {
        return Array.from(this._entries.entries()).map(function (_a) {
            var _b = __read$2(_a, 2), k = _b[0], v = _b[1];
            return [k, v];
        });
    };
    BaggageImpl.prototype.setEntry = function (key, entry) {
        var newBaggage = new BaggageImpl(this._entries);
        newBaggage._entries.set(key, entry);
        return newBaggage;
    };
    BaggageImpl.prototype.removeEntry = function (key) {
        var newBaggage = new BaggageImpl(this._entries);
        newBaggage._entries.delete(key);
        return newBaggage;
    };
    BaggageImpl.prototype.removeEntries = function () {
        var e_1, _a;
        var keys = [];
        for (var _i = 0; _i < arguments.length; _i++) {
            keys[_i] = arguments[_i];
        }
        var newBaggage = new BaggageImpl(this._entries);
        try {
            for (var keys_1 = __values(keys), keys_1_1 = keys_1.next(); !keys_1_1.done; keys_1_1 = keys_1.next()) {
                var key = keys_1_1.value;
                newBaggage._entries.delete(key);
            }
        }
        catch (e_1_1) { e_1 = { error: e_1_1 }; }
        finally {
            try {
                if (keys_1_1 && !keys_1_1.done && (_a = keys_1.return)) _a.call(keys_1);
            }
            finally { if (e_1) throw e_1.error; }
        }
        return newBaggage;
    };
    BaggageImpl.prototype.clear = function () {
        return new BaggageImpl();
    };
    return BaggageImpl;
}());

/*
 * Copyright The OpenTelemetry Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
/**
 * Symbol used to make BaggageEntryMetadata an opaque type
 */
var baggageEntryMetadataSymbol = Symbol('BaggageEntryMetadata');

/*
 * Copyright The OpenTelemetry Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
var diag$1 = DiagAPI.instance();
/**
 * Create a new Baggage with optional entries
 *
 * @param entries An array of baggage entries the new baggage should contain
 */
function createBaggage(entries) {
    if (entries === void 0) { entries = {}; }
    return new BaggageImpl(new Map(Object.entries(entries)));
}
/**
 * Create a serializable BaggageEntryMetadata object from a string.
 *
 * @param str string metadata. Format is currently not defined by the spec and has no special meaning.
 *
 */
function baggageEntryMetadataFromString(str) {
    if (typeof str !== 'string') {
        diag$1.error("Cannot create baggage metadata from unknown type: " + typeof str);
        str = '';
    }
    return {
        __TYPE__: baggageEntryMetadataSymbol,
        toString: function () {
            return str;
        },
    };
}

/*
 * Copyright The OpenTelemetry Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
/** Get a key to uniquely identify a context value */
function createContextKey(description) {
    // The specification states that for the same input, multiple calls should
    // return different keys. Due to the nature of the JS dependency management
    // system, this creates problems where multiple versions of some package
    // could hold different keys for the same property.
    //
    // Therefore, we use Symbol.for which returns the same key for the same input.
    return Symbol.for(description);
}
var BaseContext = /** @class */ (function () {
    /**
     * Construct a new context which inherits values from an optional parent context.
     *
     * @param parentContext a context from which to inherit values
     */
    function BaseContext(parentContext) {
        // for minification
        var self = this;
        self._currentContext = parentContext ? new Map(parentContext) : new Map();
        self.getValue = function (key) { return self._currentContext.get(key); };
        self.setValue = function (key, value) {
            var context = new BaseContext(self._currentContext);
            context._currentContext.set(key, value);
            return context;
        };
        self.deleteValue = function (key) {
            var context = new BaseContext(self._currentContext);
            context._currentContext.delete(key);
            return context;
        };
    }
    return BaseContext;
}());
/** The root context is used as the default parent context when there is no active context */
var ROOT_CONTEXT = new BaseContext();

/*
 * Copyright The OpenTelemetry Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
var consoleMap = [
    { n: 'error', c: 'error' },
    { n: 'warn', c: 'warn' },
    { n: 'info', c: 'info' },
    { n: 'debug', c: 'debug' },
    { n: 'verbose', c: 'trace' },
];
/**
 * A simple Immutable Console based diagnostic logger which will output any messages to the Console.
 * If you want to limit the amount of logging to a specific level or lower use the
 * {@link createLogLevelDiagLogger}
 */
var DiagConsoleLogger = /** @class */ (function () {
    function DiagConsoleLogger() {
        function _consoleFunc(funcName) {
            return function () {
                var args = [];
                for (var _i = 0; _i < arguments.length; _i++) {
                    args[_i] = arguments[_i];
                }
                if (console) {
                    // Some environments only expose the console when the F12 developer console is open
                    // eslint-disable-next-line no-console
                    var theFunc = console[funcName];
                    if (typeof theFunc !== 'function') {
                        // Not all environments support all functions
                        // eslint-disable-next-line no-console
                        theFunc = console.log;
                    }
                    // One last final check
                    if (typeof theFunc === 'function') {
                        return theFunc.apply(console, args);
                    }
                }
            };
        }
        for (var i = 0; i < consoleMap.length; i++) {
            this[consoleMap[i].n] = _consoleFunc(consoleMap[i].c);
        }
    }
    return DiagConsoleLogger;
}());

/*
 * Copyright The OpenTelemetry Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
var __extends = (undefined && undefined.__extends) || (function () {
    var extendStatics = function (d, b) {
        extendStatics = Object.setPrototypeOf ||
            ({ __proto__: [] } instanceof Array && function (d, b) { d.__proto__ = b; }) ||
            function (d, b) { for (var p in b) if (Object.prototype.hasOwnProperty.call(b, p)) d[p] = b[p]; };
        return extendStatics(d, b);
    };
    return function (d, b) {
        if (typeof b !== "function" && b !== null)
            throw new TypeError("Class extends value " + String(b) + " is not a constructor or null");
        extendStatics(d, b);
        function __() { this.constructor = d; }
        d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
    };
})();
/**
 * NoopMeter is a noop implementation of the {@link Meter} interface. It reuses
 * constant NoopMetrics for all of its methods.
 */
var NoopMeter = /** @class */ (function () {
    function NoopMeter() {
    }
    /**
     * @see {@link Meter.createGauge}
     */
    NoopMeter.prototype.createGauge = function (_name, _options) {
        return NOOP_GAUGE_METRIC;
    };
    /**
     * @see {@link Meter.createHistogram}
     */
    NoopMeter.prototype.createHistogram = function (_name, _options) {
        return NOOP_HISTOGRAM_METRIC;
    };
    /**
     * @see {@link Meter.createCounter}
     */
    NoopMeter.prototype.createCounter = function (_name, _options) {
        return NOOP_COUNTER_METRIC;
    };
    /**
     * @see {@link Meter.createUpDownCounter}
     */
    NoopMeter.prototype.createUpDownCounter = function (_name, _options) {
        return NOOP_UP_DOWN_COUNTER_METRIC;
    };
    /**
     * @see {@link Meter.createObservableGauge}
     */
    NoopMeter.prototype.createObservableGauge = function (_name, _options) {
        return NOOP_OBSERVABLE_GAUGE_METRIC;
    };
    /**
     * @see {@link Meter.createObservableCounter}
     */
    NoopMeter.prototype.createObservableCounter = function (_name, _options) {
        return NOOP_OBSERVABLE_COUNTER_METRIC;
    };
    /**
     * @see {@link Meter.createObservableUpDownCounter}
     */
    NoopMeter.prototype.createObservableUpDownCounter = function (_name, _options) {
        return NOOP_OBSERVABLE_UP_DOWN_COUNTER_METRIC;
    };
    /**
     * @see {@link Meter.addBatchObservableCallback}
     */
    NoopMeter.prototype.addBatchObservableCallback = function (_callback, _observables) { };
    /**
     * @see {@link Meter.removeBatchObservableCallback}
     */
    NoopMeter.prototype.removeBatchObservableCallback = function (_callback) { };
    return NoopMeter;
}());
var NoopMetric = /** @class */ (function () {
    function NoopMetric() {
    }
    return NoopMetric;
}());
var NoopCounterMetric = /** @class */ (function (_super) {
    __extends(NoopCounterMetric, _super);
    function NoopCounterMetric() {
        return _super !== null && _super.apply(this, arguments) || this;
    }
    NoopCounterMetric.prototype.add = function (_value, _attributes) { };
    return NoopCounterMetric;
}(NoopMetric));
var NoopUpDownCounterMetric = /** @class */ (function (_super) {
    __extends(NoopUpDownCounterMetric, _super);
    function NoopUpDownCounterMetric() {
        return _super !== null && _super.apply(this, arguments) || this;
    }
    NoopUpDownCounterMetric.prototype.add = function (_value, _attributes) { };
    return NoopUpDownCounterMetric;
}(NoopMetric));
var NoopGaugeMetric = /** @class */ (function (_super) {
    __extends(NoopGaugeMetric, _super);
    function NoopGaugeMetric() {
        return _super !== null && _super.apply(this, arguments) || this;
    }
    NoopGaugeMetric.prototype.record = function (_value, _attributes) { };
    return NoopGaugeMetric;
}(NoopMetric));
var NoopHistogramMetric = /** @class */ (function (_super) {
    __extends(NoopHistogramMetric, _super);
    function NoopHistogramMetric() {
        return _super !== null && _super.apply(this, arguments) || this;
    }
    NoopHistogramMetric.prototype.record = function (_value, _attributes) { };
    return NoopHistogramMetric;
}(NoopMetric));
var NoopObservableMetric = /** @class */ (function () {
    function NoopObservableMetric() {
    }
    NoopObservableMetric.prototype.addCallback = function (_callback) { };
    NoopObservableMetric.prototype.removeCallback = function (_callback) { };
    return NoopObservableMetric;
}());
var NoopObservableCounterMetric = /** @class */ (function (_super) {
    __extends(NoopObservableCounterMetric, _super);
    function NoopObservableCounterMetric() {
        return _super !== null && _super.apply(this, arguments) || this;
    }
    return NoopObservableCounterMetric;
}(NoopObservableMetric));
var NoopObservableGaugeMetric = /** @class */ (function (_super) {
    __extends(NoopObservableGaugeMetric, _super);
    function NoopObservableGaugeMetric() {
        return _super !== null && _super.apply(this, arguments) || this;
    }
    return NoopObservableGaugeMetric;
}(NoopObservableMetric));
var NoopObservableUpDownCounterMetric = /** @class */ (function (_super) {
    __extends(NoopObservableUpDownCounterMetric, _super);
    function NoopObservableUpDownCounterMetric() {
        return _super !== null && _super.apply(this, arguments) || this;
    }
    return NoopObservableUpDownCounterMetric;
}(NoopObservableMetric));
var NOOP_METER = new NoopMeter();
// Synchronous instruments
var NOOP_COUNTER_METRIC = new NoopCounterMetric();
var NOOP_GAUGE_METRIC = new NoopGaugeMetric();
var NOOP_HISTOGRAM_METRIC = new NoopHistogramMetric();
var NOOP_UP_DOWN_COUNTER_METRIC = new NoopUpDownCounterMetric();
// Asynchronous instruments
var NOOP_OBSERVABLE_COUNTER_METRIC = new NoopObservableCounterMetric();
var NOOP_OBSERVABLE_GAUGE_METRIC = new NoopObservableGaugeMetric();
var NOOP_OBSERVABLE_UP_DOWN_COUNTER_METRIC = new NoopObservableUpDownCounterMetric();
/**
 * Create a no-op Meter
 */
function createNoopMeter() {
    return NOOP_METER;
}

/*
 * Copyright The OpenTelemetry Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
/** The Type of value. It describes how the data is reported. */
var ValueType;
(function (ValueType) {
    ValueType[ValueType["INT"] = 0] = "INT";
    ValueType[ValueType["DOUBLE"] = 1] = "DOUBLE";
})(ValueType || (ValueType = {}));

/*
 * Copyright The OpenTelemetry Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
var defaultTextMapGetter = {
    get: function (carrier, key) {
        if (carrier == null) {
            return undefined;
        }
        return carrier[key];
    },
    keys: function (carrier) {
        if (carrier == null) {
            return [];
        }
        return Object.keys(carrier);
    },
};
var defaultTextMapSetter = {
    set: function (carrier, key, value) {
        if (carrier == null) {
            return;
        }
        carrier[key] = value;
    },
};

/*
 * Copyright The OpenTelemetry Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
var __read$1 = (undefined && undefined.__read) || function (o, n) {
    var m = typeof Symbol === "function" && o[Symbol.iterator];
    if (!m) return o;
    var i = m.call(o), r, ar = [], e;
    try {
        while ((n === void 0 || n-- > 0) && !(r = i.next()).done) ar.push(r.value);
    }
    catch (error) { e = { error: error }; }
    finally {
        try {
            if (r && !r.done && (m = i["return"])) m.call(i);
        }
        finally { if (e) throw e.error; }
    }
    return ar;
};
var __spreadArray$1 = (undefined && undefined.__spreadArray) || function (to, from, pack) {
    if (pack || arguments.length === 2) for (var i = 0, l = from.length, ar; i < l; i++) {
        if (ar || !(i in from)) {
            if (!ar) ar = Array.prototype.slice.call(from, 0, i);
            ar[i] = from[i];
        }
    }
    return to.concat(ar || Array.prototype.slice.call(from));
};
var NoopContextManager = /** @class */ (function () {
    function NoopContextManager() {
    }
    NoopContextManager.prototype.active = function () {
        return ROOT_CONTEXT;
    };
    NoopContextManager.prototype.with = function (_context, fn, thisArg) {
        var args = [];
        for (var _i = 3; _i < arguments.length; _i++) {
            args[_i - 3] = arguments[_i];
        }
        return fn.call.apply(fn, __spreadArray$1([thisArg], __read$1(args), false));
    };
    NoopContextManager.prototype.bind = function (_context, target) {
        return target;
    };
    NoopContextManager.prototype.enable = function () {
        return this;
    };
    NoopContextManager.prototype.disable = function () {
        return this;
    };
    return NoopContextManager;
}());

/*
 * Copyright The OpenTelemetry Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
var __read = (undefined && undefined.__read) || function (o, n) {
    var m = typeof Symbol === "function" && o[Symbol.iterator];
    if (!m) return o;
    var i = m.call(o), r, ar = [], e;
    try {
        while ((n === void 0 || n-- > 0) && !(r = i.next()).done) ar.push(r.value);
    }
    catch (error) { e = { error: error }; }
    finally {
        try {
            if (r && !r.done && (m = i["return"])) m.call(i);
        }
        finally { if (e) throw e.error; }
    }
    return ar;
};
var __spreadArray = (undefined && undefined.__spreadArray) || function (to, from, pack) {
    if (pack || arguments.length === 2) for (var i = 0, l = from.length, ar; i < l; i++) {
        if (ar || !(i in from)) {
            if (!ar) ar = Array.prototype.slice.call(from, 0, i);
            ar[i] = from[i];
        }
    }
    return to.concat(ar || Array.prototype.slice.call(from));
};
var API_NAME$3 = 'context';
var NOOP_CONTEXT_MANAGER = new NoopContextManager();
/**
 * Singleton object which represents the entry point to the OpenTelemetry Context API
 */
var ContextAPI = /** @class */ (function () {
    /** Empty private constructor prevents end users from constructing a new instance of the API */
    function ContextAPI() {
    }
    /** Get the singleton instance of the Context API */
    ContextAPI.getInstance = function () {
        if (!this._instance) {
            this._instance = new ContextAPI();
        }
        return this._instance;
    };
    /**
     * Set the current context manager.
     *
     * @returns true if the context manager was successfully registered, else false
     */
    ContextAPI.prototype.setGlobalContextManager = function (contextManager) {
        return registerGlobal(API_NAME$3, contextManager, DiagAPI.instance());
    };
    /**
     * Get the currently active context
     */
    ContextAPI.prototype.active = function () {
        return this._getContextManager().active();
    };
    /**
     * Execute a function with an active context
     *
     * @param context context to be active during function execution
     * @param fn function to execute in a context
     * @param thisArg optional receiver to be used for calling fn
     * @param args optional arguments forwarded to fn
     */
    ContextAPI.prototype.with = function (context, fn, thisArg) {
        var _a;
        var args = [];
        for (var _i = 3; _i < arguments.length; _i++) {
            args[_i - 3] = arguments[_i];
        }
        return (_a = this._getContextManager()).with.apply(_a, __spreadArray([context, fn, thisArg], __read(args), false));
    };
    /**
     * Bind a context to a target function or event emitter
     *
     * @param context context to bind to the event emitter or function. Defaults to the currently active context
     * @param target function or event emitter to bind
     */
    ContextAPI.prototype.bind = function (context, target) {
        return this._getContextManager().bind(context, target);
    };
    ContextAPI.prototype._getContextManager = function () {
        return getGlobal(API_NAME$3) || NOOP_CONTEXT_MANAGER;
    };
    /** Disable and remove the global context manager */
    ContextAPI.prototype.disable = function () {
        this._getContextManager().disable();
        unregisterGlobal(API_NAME$3, DiagAPI.instance());
    };
    return ContextAPI;
}());

/*
 * Copyright The OpenTelemetry Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
var TraceFlags;
(function (TraceFlags) {
    /** Represents no flag set. */
    TraceFlags[TraceFlags["NONE"] = 0] = "NONE";
    /** Bit to represent whether trace is sampled in trace flags. */
    TraceFlags[TraceFlags["SAMPLED"] = 1] = "SAMPLED";
})(TraceFlags || (TraceFlags = {}));

/*
 * Copyright The OpenTelemetry Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
var INVALID_SPANID = '0000000000000000';
var INVALID_TRACEID = '00000000000000000000000000000000';
var INVALID_SPAN_CONTEXT = {
    traceId: INVALID_TRACEID,
    spanId: INVALID_SPANID,
    traceFlags: TraceFlags.NONE,
};

/*
 * Copyright The OpenTelemetry Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
/**
 * The NonRecordingSpan is the default {@link Span} that is used when no Span
 * implementation is available. All operations are no-op including context
 * propagation.
 */
var NonRecordingSpan = /** @class */ (function () {
    function NonRecordingSpan(_spanContext) {
        if (_spanContext === void 0) { _spanContext = INVALID_SPAN_CONTEXT; }
        this._spanContext = _spanContext;
    }
    // Returns a SpanContext.
    NonRecordingSpan.prototype.spanContext = function () {
        return this._spanContext;
    };
    // By default does nothing
    NonRecordingSpan.prototype.setAttribute = function (_key, _value) {
        return this;
    };
    // By default does nothing
    NonRecordingSpan.prototype.setAttributes = function (_attributes) {
        return this;
    };
    // By default does nothing
    NonRecordingSpan.prototype.addEvent = function (_name, _attributes) {
        return this;
    };
    NonRecordingSpan.prototype.addLink = function (_link) {
        return this;
    };
    NonRecordingSpan.prototype.addLinks = function (_links) {
        return this;
    };
    // By default does nothing
    NonRecordingSpan.prototype.setStatus = function (_status) {
        return this;
    };
    // By default does nothing
    NonRecordingSpan.prototype.updateName = function (_name) {
        return this;
    };
    // By default does nothing
    NonRecordingSpan.prototype.end = function (_endTime) { };
    // isRecording always returns false for NonRecordingSpan.
    NonRecordingSpan.prototype.isRecording = function () {
        return false;
    };
    // By default does nothing
    NonRecordingSpan.prototype.recordException = function (_exception, _time) { };
    return NonRecordingSpan;
}());

/*
 * Copyright The OpenTelemetry Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
/**
 * span key
 */
var SPAN_KEY = createContextKey('OpenTelemetry Context Key SPAN');
/**
 * Return the span if one exists
 *
 * @param context context to get span from
 */
function getSpan(context) {
    return context.getValue(SPAN_KEY) || undefined;
}
/**
 * Gets the span from the current context, if one exists.
 */
function getActiveSpan() {
    return getSpan(ContextAPI.getInstance().active());
}
/**
 * Set the span on a context
 *
 * @param context context to use as parent
 * @param span span to set active
 */
function setSpan(context, span) {
    return context.setValue(SPAN_KEY, span);
}
/**
 * Remove current span stored in the context
 *
 * @param context context to delete span from
 */
function deleteSpan(context) {
    return context.deleteValue(SPAN_KEY);
}
/**
 * Wrap span context in a NoopSpan and set as span in a new
 * context
 *
 * @param context context to set active span on
 * @param spanContext span context to be wrapped
 */
function setSpanContext(context, spanContext) {
    return setSpan(context, new NonRecordingSpan(spanContext));
}
/**
 * Get the span context of the span if it exists.
 *
 * @param context context to get values from
 */
function getSpanContext(context) {
    var _a;
    return (_a = getSpan(context)) === null || _a === void 0 ? void 0 : _a.spanContext();
}

/*
 * Copyright The OpenTelemetry Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
var VALID_TRACEID_REGEX = /^([0-9a-f]{32})$/i;
var VALID_SPANID_REGEX = /^[0-9a-f]{16}$/i;
function isValidTraceId(traceId) {
    return VALID_TRACEID_REGEX.test(traceId) && traceId !== INVALID_TRACEID;
}
function isValidSpanId(spanId) {
    return VALID_SPANID_REGEX.test(spanId) && spanId !== INVALID_SPANID;
}
/**
 * Returns true if this {@link SpanContext} is valid.
 * @return true if this {@link SpanContext} is valid.
 */
function isSpanContextValid(spanContext) {
    return (isValidTraceId(spanContext.traceId) && isValidSpanId(spanContext.spanId));
}
/**
 * Wrap the given {@link SpanContext} in a new non-recording {@link Span}
 *
 * @param spanContext span context to be wrapped
 * @returns a new non-recording {@link Span} with the provided context
 */
function wrapSpanContext(spanContext) {
    return new NonRecordingSpan(spanContext);
}

/*
 * Copyright The OpenTelemetry Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
var contextApi = ContextAPI.getInstance();
/**
 * No-op implementations of {@link Tracer}.
 */
var NoopTracer = /** @class */ (function () {
    function NoopTracer() {
    }
    // startSpan starts a noop span.
    NoopTracer.prototype.startSpan = function (name, options, context) {
        if (context === void 0) { context = contextApi.active(); }
        var root = Boolean(options === null || options === void 0 ? void 0 : options.root);
        if (root) {
            return new NonRecordingSpan();
        }
        var parentFromContext = context && getSpanContext(context);
        if (isSpanContext(parentFromContext) &&
            isSpanContextValid(parentFromContext)) {
            return new NonRecordingSpan(parentFromContext);
        }
        else {
            return new NonRecordingSpan();
        }
    };
    NoopTracer.prototype.startActiveSpan = function (name, arg2, arg3, arg4) {
        var opts;
        var ctx;
        var fn;
        if (arguments.length < 2) {
            return;
        }
        else if (arguments.length === 2) {
            fn = arg2;
        }
        else if (arguments.length === 3) {
            opts = arg2;
            fn = arg3;
        }
        else {
            opts = arg2;
            ctx = arg3;
            fn = arg4;
        }
        var parentContext = ctx !== null && ctx !== void 0 ? ctx : contextApi.active();
        var span = this.startSpan(name, opts, parentContext);
        var contextWithSpanSet = setSpan(parentContext, span);
        return contextApi.with(contextWithSpanSet, fn, undefined, span);
    };
    return NoopTracer;
}());
function isSpanContext(spanContext) {
    return (typeof spanContext === 'object' &&
        typeof spanContext['spanId'] === 'string' &&
        typeof spanContext['traceId'] === 'string' &&
        typeof spanContext['traceFlags'] === 'number');
}

/*
 * Copyright The OpenTelemetry Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
var NOOP_TRACER = new NoopTracer();
/**
 * Proxy tracer provided by the proxy tracer provider
 */
var ProxyTracer = /** @class */ (function () {
    function ProxyTracer(_provider, name, version, options) {
        this._provider = _provider;
        this.name = name;
        this.version = version;
        this.options = options;
    }
    ProxyTracer.prototype.startSpan = function (name, options, context) {
        return this._getTracer().startSpan(name, options, context);
    };
    ProxyTracer.prototype.startActiveSpan = function (_name, _options, _context, _fn) {
        var tracer = this._getTracer();
        return Reflect.apply(tracer.startActiveSpan, tracer, arguments);
    };
    /**
     * Try to get a tracer from the proxy tracer provider.
     * If the proxy tracer provider has no delegate, return a noop tracer.
     */
    ProxyTracer.prototype._getTracer = function () {
        if (this._delegate) {
            return this._delegate;
        }
        var tracer = this._provider.getDelegateTracer(this.name, this.version, this.options);
        if (!tracer) {
            return NOOP_TRACER;
        }
        this._delegate = tracer;
        return this._delegate;
    };
    return ProxyTracer;
}());

/*
 * Copyright The OpenTelemetry Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
/**
 * An implementation of the {@link TracerProvider} which returns an impotent
 * Tracer for all calls to `getTracer`.
 *
 * All operations are no-op.
 */
var NoopTracerProvider = /** @class */ (function () {
    function NoopTracerProvider() {
    }
    NoopTracerProvider.prototype.getTracer = function (_name, _version, _options) {
        return new NoopTracer();
    };
    return NoopTracerProvider;
}());

/*
 * Copyright The OpenTelemetry Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
var NOOP_TRACER_PROVIDER = new NoopTracerProvider();
/**
 * Tracer provider which provides {@link ProxyTracer}s.
 *
 * Before a delegate is set, tracers provided are NoOp.
 *   When a delegate is set, traces are provided from the delegate.
 *   When a delegate is set after tracers have already been provided,
 *   all tracers already provided will use the provided delegate implementation.
 */
var ProxyTracerProvider = /** @class */ (function () {
    function ProxyTracerProvider() {
    }
    /**
     * Get a {@link ProxyTracer}
     */
    ProxyTracerProvider.prototype.getTracer = function (name, version, options) {
        var _a;
        return ((_a = this.getDelegateTracer(name, version, options)) !== null && _a !== void 0 ? _a : new ProxyTracer(this, name, version, options));
    };
    ProxyTracerProvider.prototype.getDelegate = function () {
        var _a;
        return (_a = this._delegate) !== null && _a !== void 0 ? _a : NOOP_TRACER_PROVIDER;
    };
    /**
     * Set the delegate tracer provider
     */
    ProxyTracerProvider.prototype.setDelegate = function (delegate) {
        this._delegate = delegate;
    };
    ProxyTracerProvider.prototype.getDelegateTracer = function (name, version, options) {
        var _a;
        return (_a = this._delegate) === null || _a === void 0 ? void 0 : _a.getTracer(name, version, options);
    };
    return ProxyTracerProvider;
}());

/*
 * Copyright The OpenTelemetry Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
/**
 * @deprecated use the one declared in @opentelemetry/sdk-trace-base instead.
 * A sampling decision that determines how a {@link Span} will be recorded
 * and collected.
 */
var SamplingDecision;
(function (SamplingDecision) {
    /**
     * `Span.isRecording() === false`, span will not be recorded and all events
     * and attributes will be dropped.
     */
    SamplingDecision[SamplingDecision["NOT_RECORD"] = 0] = "NOT_RECORD";
    /**
     * `Span.isRecording() === true`, but `Sampled` flag in {@link TraceFlags}
     * MUST NOT be set.
     */
    SamplingDecision[SamplingDecision["RECORD"] = 1] = "RECORD";
    /**
     * `Span.isRecording() === true` AND `Sampled` flag in {@link TraceFlags}
     * MUST be set.
     */
    SamplingDecision[SamplingDecision["RECORD_AND_SAMPLED"] = 2] = "RECORD_AND_SAMPLED";
})(SamplingDecision || (SamplingDecision = {}));

/*
 * Copyright The OpenTelemetry Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
var SpanKind;
(function (SpanKind) {
    /** Default value. Indicates that the span is used internally. */
    SpanKind[SpanKind["INTERNAL"] = 0] = "INTERNAL";
    /**
     * Indicates that the span covers server-side handling of an RPC or other
     * remote request.
     */
    SpanKind[SpanKind["SERVER"] = 1] = "SERVER";
    /**
     * Indicates that the span covers the client-side wrapper around an RPC or
     * other remote request.
     */
    SpanKind[SpanKind["CLIENT"] = 2] = "CLIENT";
    /**
     * Indicates that the span describes producer sending a message to a
     * broker. Unlike client and server, there is no direct critical path latency
     * relationship between producer and consumer spans.
     */
    SpanKind[SpanKind["PRODUCER"] = 3] = "PRODUCER";
    /**
     * Indicates that the span describes consumer receiving a message from a
     * broker. Unlike client and server, there is no direct critical path latency
     * relationship between producer and consumer spans.
     */
    SpanKind[SpanKind["CONSUMER"] = 4] = "CONSUMER";
})(SpanKind || (SpanKind = {}));

/**
 * An enumeration of status codes.
 */
var SpanStatusCode;
(function (SpanStatusCode) {
    /**
     * The default status.
     */
    SpanStatusCode[SpanStatusCode["UNSET"] = 0] = "UNSET";
    /**
     * The operation has been validated by an Application developer or
     * Operator to have completed successfully.
     */
    SpanStatusCode[SpanStatusCode["OK"] = 1] = "OK";
    /**
     * The operation contains an error.
     */
    SpanStatusCode[SpanStatusCode["ERROR"] = 2] = "ERROR";
})(SpanStatusCode || (SpanStatusCode = {}));

/*
 * Copyright The OpenTelemetry Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
var VALID_KEY_CHAR_RANGE = '[_0-9a-z-*/]';
var VALID_KEY = "[a-z]" + VALID_KEY_CHAR_RANGE + "{0,255}";
var VALID_VENDOR_KEY = "[a-z0-9]" + VALID_KEY_CHAR_RANGE + "{0,240}@[a-z]" + VALID_KEY_CHAR_RANGE + "{0,13}";
var VALID_KEY_REGEX = new RegExp("^(?:" + VALID_KEY + "|" + VALID_VENDOR_KEY + ")$");
var VALID_VALUE_BASE_REGEX = /^[ -~]{0,255}[!-~]$/;
var INVALID_VALUE_COMMA_EQUAL_REGEX = /,|=/;
/**
 * Key is opaque string up to 256 characters printable. It MUST begin with a
 * lowercase letter, and can only contain lowercase letters a-z, digits 0-9,
 * underscores _, dashes -, asterisks *, and forward slashes /.
 * For multi-tenant vendor scenarios, an at sign (@) can be used to prefix the
 * vendor name. Vendors SHOULD set the tenant ID at the beginning of the key.
 * see https://www.w3.org/TR/trace-context/#key
 */
function validateKey(key) {
    return VALID_KEY_REGEX.test(key);
}
/**
 * Value is opaque string up to 256 characters printable ASCII RFC0020
 * characters (i.e., the range 0x20 to 0x7E) except comma , and =.
 */
function validateValue(value) {
    return (VALID_VALUE_BASE_REGEX.test(value) &&
        !INVALID_VALUE_COMMA_EQUAL_REGEX.test(value));
}

/*
 * Copyright The OpenTelemetry Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
var MAX_TRACE_STATE_ITEMS = 32;
var MAX_TRACE_STATE_LEN = 512;
var LIST_MEMBERS_SEPARATOR = ',';
var LIST_MEMBER_KEY_VALUE_SPLITTER = '=';
/**
 * TraceState must be a class and not a simple object type because of the spec
 * requirement (https://www.w3.org/TR/trace-context/#tracestate-field).
 *
 * Here is the list of allowed mutations:
 * - New key-value pair should be added into the beginning of the list
 * - The value of any key can be updated. Modified keys MUST be moved to the
 * beginning of the list.
 */
var TraceStateImpl = /** @class */ (function () {
    function TraceStateImpl(rawTraceState) {
        this._internalState = new Map();
        if (rawTraceState)
            this._parse(rawTraceState);
    }
    TraceStateImpl.prototype.set = function (key, value) {
        // TODO: Benchmark the different approaches(map vs list) and
        // use the faster one.
        var traceState = this._clone();
        if (traceState._internalState.has(key)) {
            traceState._internalState.delete(key);
        }
        traceState._internalState.set(key, value);
        return traceState;
    };
    TraceStateImpl.prototype.unset = function (key) {
        var traceState = this._clone();
        traceState._internalState.delete(key);
        return traceState;
    };
    TraceStateImpl.prototype.get = function (key) {
        return this._internalState.get(key);
    };
    TraceStateImpl.prototype.serialize = function () {
        var _this = this;
        return this._keys()
            .reduce(function (agg, key) {
            agg.push(key + LIST_MEMBER_KEY_VALUE_SPLITTER + _this.get(key));
            return agg;
        }, [])
            .join(LIST_MEMBERS_SEPARATOR);
    };
    TraceStateImpl.prototype._parse = function (rawTraceState) {
        if (rawTraceState.length > MAX_TRACE_STATE_LEN)
            return;
        this._internalState = rawTraceState
            .split(LIST_MEMBERS_SEPARATOR)
            .reverse() // Store in reverse so new keys (.set(...)) will be placed at the beginning
            .reduce(function (agg, part) {
            var listMember = part.trim(); // Optional Whitespace (OWS) handling
            var i = listMember.indexOf(LIST_MEMBER_KEY_VALUE_SPLITTER);
            if (i !== -1) {
                var key = listMember.slice(0, i);
                var value = listMember.slice(i + 1, part.length);
                if (validateKey(key) && validateValue(value)) {
                    agg.set(key, value);
                }
            }
            return agg;
        }, new Map());
        // Because of the reverse() requirement, trunc must be done after map is created
        if (this._internalState.size > MAX_TRACE_STATE_ITEMS) {
            this._internalState = new Map(Array.from(this._internalState.entries())
                .reverse() // Use reverse same as original tracestate parse chain
                .slice(0, MAX_TRACE_STATE_ITEMS));
        }
    };
    TraceStateImpl.prototype._keys = function () {
        return Array.from(this._internalState.keys()).reverse();
    };
    TraceStateImpl.prototype._clone = function () {
        var traceState = new TraceStateImpl();
        traceState._internalState = new Map(this._internalState);
        return traceState;
    };
    return TraceStateImpl;
}());

/*
 * Copyright The OpenTelemetry Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
function createTraceState(rawTraceState) {
    return new TraceStateImpl(rawTraceState);
}

/*
 * Copyright The OpenTelemetry Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
// Split module-level variable definition into separate files to allow
// tree-shaking on each api instance.
/** Entrypoint for context API */
var context = ContextAPI.getInstance();

/*
 * Copyright The OpenTelemetry Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
// Split module-level variable definition into separate files to allow
// tree-shaking on each api instance.
/**
 * Entrypoint for Diag API.
 * Defines Diagnostic handler used for internal diagnostic logging operations.
 * The default provides a Noop DiagLogger implementation which may be changed via the
 * diag.setLogger(logger: DiagLogger) function.
 */
var diag = DiagAPI.instance();

/*
 * Copyright The OpenTelemetry Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
/**
 * An implementation of the {@link MeterProvider} which returns an impotent Meter
 * for all calls to `getMeter`
 */
var NoopMeterProvider = /** @class */ (function () {
    function NoopMeterProvider() {
    }
    NoopMeterProvider.prototype.getMeter = function (_name, _version, _options) {
        return NOOP_METER;
    };
    return NoopMeterProvider;
}());
var NOOP_METER_PROVIDER = new NoopMeterProvider();

/*
 * Copyright The OpenTelemetry Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
var API_NAME$2 = 'metrics';
/**
 * Singleton object which represents the entry point to the OpenTelemetry Metrics API
 */
var MetricsAPI = /** @class */ (function () {
    /** Empty private constructor prevents end users from constructing a new instance of the API */
    function MetricsAPI() {
    }
    /** Get the singleton instance of the Metrics API */
    MetricsAPI.getInstance = function () {
        if (!this._instance) {
            this._instance = new MetricsAPI();
        }
        return this._instance;
    };
    /**
     * Set the current global meter provider.
     * Returns true if the meter provider was successfully registered, else false.
     */
    MetricsAPI.prototype.setGlobalMeterProvider = function (provider) {
        return registerGlobal(API_NAME$2, provider, DiagAPI.instance());
    };
    /**
     * Returns the global meter provider.
     */
    MetricsAPI.prototype.getMeterProvider = function () {
        return getGlobal(API_NAME$2) || NOOP_METER_PROVIDER;
    };
    /**
     * Returns a meter from the global meter provider.
     */
    MetricsAPI.prototype.getMeter = function (name, version, options) {
        return this.getMeterProvider().getMeter(name, version, options);
    };
    /** Remove the global meter provider */
    MetricsAPI.prototype.disable = function () {
        unregisterGlobal(API_NAME$2, DiagAPI.instance());
    };
    return MetricsAPI;
}());

/*
 * Copyright The OpenTelemetry Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
// Split module-level variable definition into separate files to allow
// tree-shaking on each api instance.
/** Entrypoint for metrics API */
var metrics = MetricsAPI.getInstance();

/*
 * Copyright The OpenTelemetry Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
/**
 * No-op implementations of {@link TextMapPropagator}.
 */
var NoopTextMapPropagator = /** @class */ (function () {
    function NoopTextMapPropagator() {
    }
    /** Noop inject function does nothing */
    NoopTextMapPropagator.prototype.inject = function (_context, _carrier) { };
    /** Noop extract function does nothing and returns the input context */
    NoopTextMapPropagator.prototype.extract = function (context, _carrier) {
        return context;
    };
    NoopTextMapPropagator.prototype.fields = function () {
        return [];
    };
    return NoopTextMapPropagator;
}());

/*
 * Copyright The OpenTelemetry Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
/**
 * Baggage key
 */
var BAGGAGE_KEY = createContextKey('OpenTelemetry Baggage Key');
/**
 * Retrieve the current baggage from the given context
 *
 * @param {Context} Context that manage all context values
 * @returns {Baggage} Extracted baggage from the context
 */
function getBaggage(context) {
    return context.getValue(BAGGAGE_KEY) || undefined;
}
/**
 * Retrieve the current baggage from the active/current context
 *
 * @returns {Baggage} Extracted baggage from the context
 */
function getActiveBaggage() {
    return getBaggage(ContextAPI.getInstance().active());
}
/**
 * Store a baggage in the given context
 *
 * @param {Context} Context that manage all context values
 * @param {Baggage} baggage that will be set in the actual context
 */
function setBaggage(context, baggage) {
    return context.setValue(BAGGAGE_KEY, baggage);
}
/**
 * Delete the baggage stored in the given context
 *
 * @param {Context} Context that manage all context values
 */
function deleteBaggage(context) {
    return context.deleteValue(BAGGAGE_KEY);
}

/*
 * Copyright The OpenTelemetry Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
var API_NAME$1 = 'propagation';
var NOOP_TEXT_MAP_PROPAGATOR = new NoopTextMapPropagator();
/**
 * Singleton object which represents the entry point to the OpenTelemetry Propagation API
 */
var PropagationAPI = /** @class */ (function () {
    /** Empty private constructor prevents end users from constructing a new instance of the API */
    function PropagationAPI() {
        this.createBaggage = createBaggage;
        this.getBaggage = getBaggage;
        this.getActiveBaggage = getActiveBaggage;
        this.setBaggage = setBaggage;
        this.deleteBaggage = deleteBaggage;
    }
    /** Get the singleton instance of the Propagator API */
    PropagationAPI.getInstance = function () {
        if (!this._instance) {
            this._instance = new PropagationAPI();
        }
        return this._instance;
    };
    /**
     * Set the current propagator.
     *
     * @returns true if the propagator was successfully registered, else false
     */
    PropagationAPI.prototype.setGlobalPropagator = function (propagator) {
        return registerGlobal(API_NAME$1, propagator, DiagAPI.instance());
    };
    /**
     * Inject context into a carrier to be propagated inter-process
     *
     * @param context Context carrying tracing data to inject
     * @param carrier carrier to inject context into
     * @param setter Function used to set values on the carrier
     */
    PropagationAPI.prototype.inject = function (context, carrier, setter) {
        if (setter === void 0) { setter = defaultTextMapSetter; }
        return this._getGlobalPropagator().inject(context, carrier, setter);
    };
    /**
     * Extract context from a carrier
     *
     * @param context Context which the newly created context will inherit from
     * @param carrier Carrier to extract context from
     * @param getter Function used to extract keys from a carrier
     */
    PropagationAPI.prototype.extract = function (context, carrier, getter) {
        if (getter === void 0) { getter = defaultTextMapGetter; }
        return this._getGlobalPropagator().extract(context, carrier, getter);
    };
    /**
     * Return a list of all fields which may be used by the propagator.
     */
    PropagationAPI.prototype.fields = function () {
        return this._getGlobalPropagator().fields();
    };
    /** Remove the global propagator */
    PropagationAPI.prototype.disable = function () {
        unregisterGlobal(API_NAME$1, DiagAPI.instance());
    };
    PropagationAPI.prototype._getGlobalPropagator = function () {
        return getGlobal(API_NAME$1) || NOOP_TEXT_MAP_PROPAGATOR;
    };
    return PropagationAPI;
}());

/*
 * Copyright The OpenTelemetry Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
// Split module-level variable definition into separate files to allow
// tree-shaking on each api instance.
/** Entrypoint for propagation API */
var propagation = PropagationAPI.getInstance();

/*
 * Copyright The OpenTelemetry Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
var API_NAME = 'trace';
/**
 * Singleton object which represents the entry point to the OpenTelemetry Tracing API
 */
var TraceAPI = /** @class */ (function () {
    /** Empty private constructor prevents end users from constructing a new instance of the API */
    function TraceAPI() {
        this._proxyTracerProvider = new ProxyTracerProvider();
        this.wrapSpanContext = wrapSpanContext;
        this.isSpanContextValid = isSpanContextValid;
        this.deleteSpan = deleteSpan;
        this.getSpan = getSpan;
        this.getActiveSpan = getActiveSpan;
        this.getSpanContext = getSpanContext;
        this.setSpan = setSpan;
        this.setSpanContext = setSpanContext;
    }
    /** Get the singleton instance of the Trace API */
    TraceAPI.getInstance = function () {
        if (!this._instance) {
            this._instance = new TraceAPI();
        }
        return this._instance;
    };
    /**
     * Set the current global tracer.
     *
     * @returns true if the tracer provider was successfully registered, else false
     */
    TraceAPI.prototype.setGlobalTracerProvider = function (provider) {
        var success = registerGlobal(API_NAME, this._proxyTracerProvider, DiagAPI.instance());
        if (success) {
            this._proxyTracerProvider.setDelegate(provider);
        }
        return success;
    };
    /**
     * Returns the global tracer provider.
     */
    TraceAPI.prototype.getTracerProvider = function () {
        return getGlobal(API_NAME) || this._proxyTracerProvider;
    };
    /**
     * Returns a tracer from the global tracer provider.
     */
    TraceAPI.prototype.getTracer = function (name, version) {
        return this.getTracerProvider().getTracer(name, version);
    };
    /** Remove the global tracer provider */
    TraceAPI.prototype.disable = function () {
        unregisterGlobal(API_NAME, DiagAPI.instance());
        this._proxyTracerProvider = new ProxyTracerProvider();
    };
    return TraceAPI;
}());

/*
 * Copyright The OpenTelemetry Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
// Split module-level variable definition into separate files to allow
// tree-shaking on each api instance.
/** Entrypoint for trace API */
var trace = TraceAPI.getInstance();

/*
 * Copyright The OpenTelemetry Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
// Default export.
var index = {
    context: context,
    diag: diag,
    metrics: metrics,
    propagation: propagation,
    trace: trace,
};

var esm = /*#__PURE__*/Object.freeze({
	__proto__: null,
	DiagConsoleLogger: DiagConsoleLogger,
	get DiagLogLevel () { return DiagLogLevel; },
	INVALID_SPANID: INVALID_SPANID,
	INVALID_SPAN_CONTEXT: INVALID_SPAN_CONTEXT,
	INVALID_TRACEID: INVALID_TRACEID,
	ProxyTracer: ProxyTracer,
	ProxyTracerProvider: ProxyTracerProvider,
	ROOT_CONTEXT: ROOT_CONTEXT,
	get SamplingDecision () { return SamplingDecision; },
	get SpanKind () { return SpanKind; },
	get SpanStatusCode () { return SpanStatusCode; },
	get TraceFlags () { return TraceFlags; },
	get ValueType () { return ValueType; },
	baggageEntryMetadataFromString: baggageEntryMetadataFromString,
	context: context,
	createContextKey: createContextKey,
	createNoopMeter: createNoopMeter,
	createTraceState: createTraceState,
	default: index,
	defaultTextMapGetter: defaultTextMapGetter,
	defaultTextMapSetter: defaultTextMapSetter,
	diag: diag,
	isSpanContextValid: isSpanContextValid,
	isValidSpanId: isValidSpanId,
	isValidTraceId: isValidTraceId,
	metrics: metrics,
	propagation: propagation,
	trace: trace
});

var require$$0 = /*@__PURE__*/getAugmentedNamespace(esm);

var hasRequiredProcessCpuTotal;

function requireProcessCpuTotal () {
	if (hasRequiredProcessCpuTotal) return processCpuTotal.exports;
	hasRequiredProcessCpuTotal = 1;

	const OtelApi = require$$0;
	const Counter = requireCounter();

	const PROCESS_CPU_USER_SECONDS = 'process_cpu_user_seconds_total';
	const PROCESS_CPU_SYSTEM_SECONDS = 'process_cpu_system_seconds_total';
	const PROCESS_CPU_SECONDS = 'process_cpu_seconds_total';

	processCpuTotal.exports = (registry, config = {}) => {
		const registers = registry ? [registry] : undefined;
		const namePrefix = config.prefix ? config.prefix : '';
		const labels = config.labels ? config.labels : {};
		const exemplars = config.enableExemplars ? config.enableExemplars : false;
		const labelNames = Object.keys(labels);

		let lastCpuUsage = process.cpuUsage();

		const cpuUserUsageCounter = new Counter({
			name: namePrefix + PROCESS_CPU_USER_SECONDS,
			help: 'Total user CPU time spent in seconds.',
			enableExemplars: exemplars,
			registers,
			labelNames,
			// Use this one metric's `collect` to set all metrics' values.
			collect() {
				const cpuUsage = process.cpuUsage();

				const userUsageMicros = cpuUsage.user - lastCpuUsage.user;
				const systemUsageMicros = cpuUsage.system - lastCpuUsage.system;

				lastCpuUsage = cpuUsage;

				if (this.enableExemplars) {
					let exemplarLabels = {};
					const currentSpan = OtelApi.trace.getSpan(OtelApi.context.active());
					if (currentSpan) {
						exemplarLabels = {
							traceId: currentSpan.spanContext().traceId,
							spanId: currentSpan.spanContext().spanId,
						};
					}
					cpuUserUsageCounter.inc({
						labels,
						value: userUsageMicros / 1e6,
						exemplarLabels,
					});
					cpuSystemUsageCounter.inc({
						labels,
						value: systemUsageMicros / 1e6,
						exemplarLabels,
					});
					cpuUsageCounter.inc({
						labels,
						value: (userUsageMicros + systemUsageMicros) / 1e6,
						exemplarLabels,
					});
				} else {
					cpuUserUsageCounter.inc(labels, userUsageMicros / 1e6);
					cpuSystemUsageCounter.inc(labels, systemUsageMicros / 1e6);
					cpuUsageCounter.inc(
						labels,
						(userUsageMicros + systemUsageMicros) / 1e6,
					);
				}
			},
		});
		const cpuSystemUsageCounter = new Counter({
			name: namePrefix + PROCESS_CPU_SYSTEM_SECONDS,
			help: 'Total system CPU time spent in seconds.',
			enableExemplars: exemplars,
			registers,
			labelNames,
		});
		const cpuUsageCounter = new Counter({
			name: namePrefix + PROCESS_CPU_SECONDS,
			help: 'Total user and system CPU time spent in seconds.',
			enableExemplars: exemplars,
			registers,
			labelNames,
		});
	};

	processCpuTotal.exports.metricNames = [
		PROCESS_CPU_USER_SECONDS,
		PROCESS_CPU_SYSTEM_SECONDS,
		PROCESS_CPU_SECONDS,
	];
	return processCpuTotal.exports;
}

var processStartTime = {exports: {}};

var hasRequiredProcessStartTime;

function requireProcessStartTime () {
	if (hasRequiredProcessStartTime) return processStartTime.exports;
	hasRequiredProcessStartTime = 1;

	const Gauge = requireGauge();
	const startInSeconds = Math.round(Date.now() / 1000 - process.uptime());

	const PROCESS_START_TIME = 'process_start_time_seconds';

	processStartTime.exports = (registry, config = {}) => {
		const namePrefix = config.prefix ? config.prefix : '';
		const labels = config.labels ? config.labels : {};
		const labelNames = Object.keys(labels);

		new Gauge({
			name: namePrefix + PROCESS_START_TIME,
			help: 'Start time of the process since unix epoch in seconds.',
			registers: registry ? [registry] : undefined,
			labelNames,
			aggregator: 'omit',
			collect() {
				this.set(labels, startInSeconds);
			},
		});
	};

	processStartTime.exports.metricNames = [PROCESS_START_TIME];
	return processStartTime.exports;
}

var osMemoryHeap = {exports: {}};

var osMemoryHeapLinux = {exports: {}};

var hasRequiredOsMemoryHeapLinux;

function requireOsMemoryHeapLinux () {
	if (hasRequiredOsMemoryHeapLinux) return osMemoryHeapLinux.exports;
	hasRequiredOsMemoryHeapLinux = 1;

	const Gauge = requireGauge();
	const fs = require$$1$1;

	const values = ['VmSize', 'VmRSS', 'VmData'];

	const PROCESS_RESIDENT_MEMORY = 'process_resident_memory_bytes';
	const PROCESS_VIRTUAL_MEMORY = 'process_virtual_memory_bytes';
	const PROCESS_HEAP = 'process_heap_bytes';

	function structureOutput(input) {
		return input.split('\n').reduce((acc, string) => {
			if (!values.some(value => string.startsWith(value))) {
				return acc;
			}

			const split = string.split(':');

			// Get the value
			let value = split[1].trim();
			// Remove trailing ` kb`
			value = value.substr(0, value.length - 3);
			// Make it into a number in bytes bytes
			value = Number(value) * 1024;

			acc[split[0]] = value;

			return acc;
		}, {});
	}

	osMemoryHeapLinux.exports = (registry, config = {}) => {
		const registers = registry ? [registry] : undefined;
		const namePrefix = config.prefix ? config.prefix : '';
		const labels = config.labels ? config.labels : {};
		const labelNames = Object.keys(labels);

		const residentMemGauge = new Gauge({
			name: namePrefix + PROCESS_RESIDENT_MEMORY,
			help: 'Resident memory size in bytes.',
			registers,
			labelNames,
			// Use this one metric's `collect` to set all metrics' values.
			collect() {
				try {
					// Sync I/O is often problematic, but /proc isn't really I/O, it
					// a virtual filesystem that maps directly to in-kernel data
					// structures and never blocks.
					//
					// Node.js/libuv do this already for process.memoryUsage(), see:
					// - https://github.com/libuv/libuv/blob/a629688008694ed8022269e66826d4d6ec688b83/src/unix/linux-core.c#L506-L523
					const stat = fs.readFileSync('/proc/self/status', 'utf8');
					const structuredOutput = structureOutput(stat);

					residentMemGauge.set(labels, structuredOutput.VmRSS);
					virtualMemGauge.set(labels, structuredOutput.VmSize);
					heapSizeMemGauge.set(labels, structuredOutput.VmData);
				} catch {
					// noop
				}
			},
		});
		const virtualMemGauge = new Gauge({
			name: namePrefix + PROCESS_VIRTUAL_MEMORY,
			help: 'Virtual memory size in bytes.',
			registers,
			labelNames,
		});
		const heapSizeMemGauge = new Gauge({
			name: namePrefix + PROCESS_HEAP,
			help: 'Process heap size in bytes.',
			registers,
			labelNames,
		});
	};

	osMemoryHeapLinux.exports.metricNames = [
		PROCESS_RESIDENT_MEMORY,
		PROCESS_VIRTUAL_MEMORY,
		PROCESS_HEAP,
	];
	return osMemoryHeapLinux.exports;
}

var safeMemoryUsage_1;
var hasRequiredSafeMemoryUsage;

function requireSafeMemoryUsage () {
	if (hasRequiredSafeMemoryUsage) return safeMemoryUsage_1;
	hasRequiredSafeMemoryUsage = 1;

	// process.memoryUsage() can throw on some platforms, see #67
	function safeMemoryUsage() {
		try {
			return process.memoryUsage();
		} catch {
			return;
		}
	}

	safeMemoryUsage_1 = safeMemoryUsage;
	return safeMemoryUsage_1;
}

var hasRequiredOsMemoryHeap;

function requireOsMemoryHeap () {
	if (hasRequiredOsMemoryHeap) return osMemoryHeap.exports;
	hasRequiredOsMemoryHeap = 1;

	const Gauge = requireGauge();
	const linuxVariant = requireOsMemoryHeapLinux();
	const safeMemoryUsage = requireSafeMemoryUsage();

	const PROCESS_RESIDENT_MEMORY = 'process_resident_memory_bytes';

	function notLinuxVariant(registry, config = {}) {
		const namePrefix = config.prefix ? config.prefix : '';
		const labels = config.labels ? config.labels : {};
		const labelNames = Object.keys(labels);

		new Gauge({
			name: namePrefix + PROCESS_RESIDENT_MEMORY,
			help: 'Resident memory size in bytes.',
			registers: registry ? [registry] : undefined,
			labelNames,
			collect() {
				const memUsage = safeMemoryUsage();

				// I don't think the other things returned from `process.memoryUsage()` is relevant to a standard export
				if (memUsage) {
					this.set(labels, memUsage.rss);
				}
			},
		});
	}

	osMemoryHeap.exports = (registry, config) =>
		process.platform === 'linux'
			? linuxVariant(registry, config)
			: notLinuxVariant(registry, config);

	osMemoryHeap.exports.metricNames =
		process.platform === 'linux'
			? linuxVariant.metricNames
			: [PROCESS_RESIDENT_MEMORY];
	return osMemoryHeap.exports;
}

var processOpenFileDescriptors = {exports: {}};

var hasRequiredProcessOpenFileDescriptors;

function requireProcessOpenFileDescriptors () {
	if (hasRequiredProcessOpenFileDescriptors) return processOpenFileDescriptors.exports;
	hasRequiredProcessOpenFileDescriptors = 1;

	const Gauge = requireGauge();
	const fs = require$$1$1;
	const process = require$$2$1;

	const PROCESS_OPEN_FDS = 'process_open_fds';

	processOpenFileDescriptors.exports = (registry, config = {}) => {
		if (process.platform !== 'linux') {
			return;
		}

		const namePrefix = config.prefix ? config.prefix : '';
		const labels = config.labels ? config.labels : {};
		const labelNames = Object.keys(labels);

		new Gauge({
			name: namePrefix + PROCESS_OPEN_FDS,
			help: 'Number of open file descriptors.',
			registers: registry ? [registry] : undefined,
			labelNames,
			collect() {
				try {
					const fds = fs.readdirSync('/proc/self/fd');
					// Minus 1 to not count the fd that was used by readdirSync(),
					// it's now closed.
					this.set(labels, fds.length - 1);
				} catch {
					// noop
				}
			},
		});
	};

	processOpenFileDescriptors.exports.metricNames = [PROCESS_OPEN_FDS];
	return processOpenFileDescriptors.exports;
}

var processMaxFileDescriptors = {exports: {}};

var hasRequiredProcessMaxFileDescriptors;

function requireProcessMaxFileDescriptors () {
	if (hasRequiredProcessMaxFileDescriptors) return processMaxFileDescriptors.exports;
	hasRequiredProcessMaxFileDescriptors = 1;

	const Gauge = requireGauge();
	const fs = require$$1$1;

	const PROCESS_MAX_FDS = 'process_max_fds';

	let maxFds;

	processMaxFileDescriptors.exports = (registry, config = {}) => {
		if (maxFds === undefined) {
			// This will fail if a linux-like procfs is not available.
			try {
				const limits = fs.readFileSync('/proc/self/limits', 'utf8');
				const lines = limits.split('\n');
				for (const line of lines) {
					if (line.startsWith('Max open files')) {
						const parts = line.split(/  +/);
						maxFds = Number(parts[1]);
						break;
					}
				}
			} catch {
				return;
			}
		}

		if (maxFds === undefined) return;

		const namePrefix = config.prefix ? config.prefix : '';
		const labels = config.labels ? config.labels : {};
		const labelNames = Object.keys(labels);

		new Gauge({
			name: namePrefix + PROCESS_MAX_FDS,
			help: 'Maximum number of open file descriptors.',
			registers: registry ? [registry] : undefined,
			labelNames,
			collect() {
				if (maxFds !== undefined) this.set(labels, maxFds);
			},
		});
	};

	processMaxFileDescriptors.exports.metricNames = [PROCESS_MAX_FDS];
	return processMaxFileDescriptors.exports;
}

var eventLoopLag = {exports: {}};

var hasRequiredEventLoopLag;

function requireEventLoopLag () {
	if (hasRequiredEventLoopLag) return eventLoopLag.exports;
	hasRequiredEventLoopLag = 1;

	const Gauge = requireGauge();

	// Check if perf_hooks module is available
	let perf_hooks;
	try {
		perf_hooks = require('perf_hooks');
	} catch {
		// node version is too old
	}

	// Reported always.
	const NODEJS_EVENTLOOP_LAG = 'nodejs_eventloop_lag_seconds';

	// Reported only when perf_hooks is available.
	const NODEJS_EVENTLOOP_LAG_MIN = 'nodejs_eventloop_lag_min_seconds';
	const NODEJS_EVENTLOOP_LAG_MAX = 'nodejs_eventloop_lag_max_seconds';
	const NODEJS_EVENTLOOP_LAG_MEAN = 'nodejs_eventloop_lag_mean_seconds';
	const NODEJS_EVENTLOOP_LAG_STDDEV = 'nodejs_eventloop_lag_stddev_seconds';
	const NODEJS_EVENTLOOP_LAG_P50 = 'nodejs_eventloop_lag_p50_seconds';
	const NODEJS_EVENTLOOP_LAG_P90 = 'nodejs_eventloop_lag_p90_seconds';
	const NODEJS_EVENTLOOP_LAG_P99 = 'nodejs_eventloop_lag_p99_seconds';

	function reportEventloopLag(start, gauge, labels) {
		const delta = process.hrtime(start);
		const nanosec = delta[0] * 1e9 + delta[1];
		const seconds = nanosec / 1e9;

		gauge.set(labels, seconds);
	}

	eventLoopLag.exports = (registry, config = {}) => {
		const namePrefix = config.prefix ? config.prefix : '';
		const labels = config.labels ? config.labels : {};
		const labelNames = Object.keys(labels);
		const registers = registry ? [registry] : undefined;

		let collect = () => {
			const start = process.hrtime();
			setImmediate(reportEventloopLag, start, lag, labels);
		};

		if (perf_hooks && perf_hooks.monitorEventLoopDelay) {
			try {
				const histogram = perf_hooks.monitorEventLoopDelay({
					resolution: config.eventLoopMonitoringPrecision,
				});
				histogram.enable();

				collect = () => {
					const start = process.hrtime();
					setImmediate(reportEventloopLag, start, lag, labels);

					lagMin.set(labels, histogram.min / 1e9);
					lagMax.set(labels, histogram.max / 1e9);
					lagMean.set(labels, histogram.mean / 1e9);
					lagStddev.set(labels, histogram.stddev / 1e9);
					lagP50.set(labels, histogram.percentile(50) / 1e9);
					lagP90.set(labels, histogram.percentile(90) / 1e9);
					lagP99.set(labels, histogram.percentile(99) / 1e9);

					histogram.reset();
				};
			} catch (e) {
				if (e.code === 'ERR_NOT_IMPLEMENTED') {
					return; // Bun
				}

				throw e;
			}
		}

		const lag = new Gauge({
			name: namePrefix + NODEJS_EVENTLOOP_LAG,
			help: 'Lag of event loop in seconds.',
			registers,
			labelNames,
			aggregator: 'average',
			// Use this one metric's `collect` to set all metrics' values.
			collect,
		});
		const lagMin = new Gauge({
			name: namePrefix + NODEJS_EVENTLOOP_LAG_MIN,
			help: 'The minimum recorded event loop delay.',
			registers,
			labelNames,
			aggregator: 'min',
		});
		const lagMax = new Gauge({
			name: namePrefix + NODEJS_EVENTLOOP_LAG_MAX,
			help: 'The maximum recorded event loop delay.',
			registers,
			labelNames,
			aggregator: 'max',
		});
		const lagMean = new Gauge({
			name: namePrefix + NODEJS_EVENTLOOP_LAG_MEAN,
			help: 'The mean of the recorded event loop delays.',
			registers,
			labelNames,
			aggregator: 'average',
		});
		const lagStddev = new Gauge({
			name: namePrefix + NODEJS_EVENTLOOP_LAG_STDDEV,
			help: 'The standard deviation of the recorded event loop delays.',
			registers,
			labelNames,
			aggregator: 'average',
		});
		const lagP50 = new Gauge({
			name: namePrefix + NODEJS_EVENTLOOP_LAG_P50,
			help: 'The 50th percentile of the recorded event loop delays.',
			registers,
			labelNames,
			aggregator: 'average',
		});
		const lagP90 = new Gauge({
			name: namePrefix + NODEJS_EVENTLOOP_LAG_P90,
			help: 'The 90th percentile of the recorded event loop delays.',
			registers,
			labelNames,
			aggregator: 'average',
		});
		const lagP99 = new Gauge({
			name: namePrefix + NODEJS_EVENTLOOP_LAG_P99,
			help: 'The 99th percentile of the recorded event loop delays.',
			registers,
			labelNames,
			aggregator: 'average',
		});
	};

	eventLoopLag.exports.metricNames = [
		NODEJS_EVENTLOOP_LAG,
		NODEJS_EVENTLOOP_LAG_MIN,
		NODEJS_EVENTLOOP_LAG_MAX,
		NODEJS_EVENTLOOP_LAG_MEAN,
		NODEJS_EVENTLOOP_LAG_STDDEV,
		NODEJS_EVENTLOOP_LAG_P50,
		NODEJS_EVENTLOOP_LAG_P90,
		NODEJS_EVENTLOOP_LAG_P99,
	];
	return eventLoopLag.exports;
}

var processHandles = {exports: {}};

var processMetricsHelpers;
var hasRequiredProcessMetricsHelpers;

function requireProcessMetricsHelpers () {
	if (hasRequiredProcessMetricsHelpers) return processMetricsHelpers;
	hasRequiredProcessMetricsHelpers = 1;

	function aggregateByObjectName(list) {
		const data = {};

		for (let i = 0; i < list.length; i++) {
			const listElement = list[i];

			if (!listElement || typeof listElement.constructor === 'undefined') {
				continue;
			}

			if (Object.hasOwnProperty.call(data, listElement.constructor.name)) {
				data[listElement.constructor.name] += 1;
			} else {
				data[listElement.constructor.name] = 1;
			}
		}
		return data;
	}

	function updateMetrics(gauge, data, labels) {
		gauge.reset();
		for (const key in data) {
			gauge.set(Object.assign({ type: key }, labels || {}), data[key]);
		}
	}

	processMetricsHelpers = {
		aggregateByObjectName,
		updateMetrics,
	};
	return processMetricsHelpers;
}

var hasRequiredProcessHandles;

function requireProcessHandles () {
	if (hasRequiredProcessHandles) return processHandles.exports;
	hasRequiredProcessHandles = 1;

	const { aggregateByObjectName } = requireProcessMetricsHelpers();
	const { updateMetrics } = requireProcessMetricsHelpers();
	const Gauge = requireGauge();

	const NODEJS_ACTIVE_HANDLES = 'nodejs_active_handles';
	const NODEJS_ACTIVE_HANDLES_TOTAL = 'nodejs_active_handles_total';

	processHandles.exports = (registry, config = {}) => {
		// Don't do anything if the function is removed in later nodes (exists in node@6-12...)
		if (typeof process._getActiveHandles !== 'function') {
			return;
		}

		const registers = registry ? [registry] : undefined;
		const namePrefix = config.prefix ? config.prefix : '';
		const labels = config.labels ? config.labels : {};
		const labelNames = Object.keys(labels);

		new Gauge({
			name: namePrefix + NODEJS_ACTIVE_HANDLES,
			help: 'Number of active libuv handles grouped by handle type. Every handle type is C++ class name.',
			labelNames: ['type', ...labelNames],
			registers,
			collect() {
				const handles = process._getActiveHandles();
				updateMetrics(this, aggregateByObjectName(handles), labels);
			},
		});
		new Gauge({
			name: namePrefix + NODEJS_ACTIVE_HANDLES_TOTAL,
			help: 'Total number of active handles.',
			registers,
			labelNames,
			collect() {
				const handles = process._getActiveHandles();
				this.set(labels, handles.length);
			},
		});
	};

	processHandles.exports.metricNames = [
		NODEJS_ACTIVE_HANDLES,
		NODEJS_ACTIVE_HANDLES_TOTAL,
	];
	return processHandles.exports;
}

var processRequests = {exports: {}};

var hasRequiredProcessRequests;

function requireProcessRequests () {
	if (hasRequiredProcessRequests) return processRequests.exports;
	hasRequiredProcessRequests = 1;
	const Gauge = requireGauge();
	const { aggregateByObjectName } = requireProcessMetricsHelpers();
	const { updateMetrics } = requireProcessMetricsHelpers();

	const NODEJS_ACTIVE_REQUESTS = 'nodejs_active_requests';
	const NODEJS_ACTIVE_REQUESTS_TOTAL = 'nodejs_active_requests_total';

	processRequests.exports = (registry, config = {}) => {
		// Don't do anything if the function is removed in later nodes (exists in node@6)
		if (typeof process._getActiveRequests !== 'function') {
			return;
		}

		const namePrefix = config.prefix ? config.prefix : '';
		const labels = config.labels ? config.labels : {};
		const labelNames = Object.keys(labels);

		new Gauge({
			name: namePrefix + NODEJS_ACTIVE_REQUESTS,
			help: 'Number of active libuv requests grouped by request type. Every request type is C++ class name.',
			labelNames: ['type', ...labelNames],
			registers: registry ? [registry] : undefined,
			collect() {
				const requests = process._getActiveRequests();
				updateMetrics(this, aggregateByObjectName(requests), labels);
			},
		});

		new Gauge({
			name: namePrefix + NODEJS_ACTIVE_REQUESTS_TOTAL,
			help: 'Total number of active requests.',
			registers: registry ? [registry] : undefined,
			labelNames,
			collect() {
				const requests = process._getActiveRequests();
				this.set(labels, requests.length);
			},
		});
	};

	processRequests.exports.metricNames = [
		NODEJS_ACTIVE_REQUESTS,
		NODEJS_ACTIVE_REQUESTS_TOTAL,
	];
	return processRequests.exports;
}

var processResources = {exports: {}};

var hasRequiredProcessResources;

function requireProcessResources () {
	if (hasRequiredProcessResources) return processResources.exports;
	hasRequiredProcessResources = 1;
	const Gauge = requireGauge();
	const { updateMetrics } = requireProcessMetricsHelpers();

	const NODEJS_ACTIVE_RESOURCES = 'nodejs_active_resources';
	const NODEJS_ACTIVE_RESOURCES_TOTAL = 'nodejs_active_resources_total';

	processResources.exports = (registry, config = {}) => {
		// Don't do anything if the function does not exist in previous nodes (exists in node@17.3.0)
		if (typeof process.getActiveResourcesInfo !== 'function') {
			return;
		}

		const namePrefix = config.prefix ? config.prefix : '';
		const labels = config.labels ? config.labels : {};
		const labelNames = Object.keys(labels);

		new Gauge({
			name: namePrefix + NODEJS_ACTIVE_RESOURCES,
			help: 'Number of active resources that are currently keeping the event loop alive, grouped by async resource type.',
			labelNames: ['type', ...labelNames],
			registers: registry ? [registry] : undefined,
			collect() {
				const resources = process.getActiveResourcesInfo();

				const data = {};

				for (let i = 0; i < resources.length; i++) {
					const resource = resources[i];

					if (Object.hasOwn(data, resource)) {
						data[resource] += 1;
					} else {
						data[resource] = 1;
					}
				}

				updateMetrics(this, data, labels);
			},
		});

		new Gauge({
			name: namePrefix + NODEJS_ACTIVE_RESOURCES_TOTAL,
			help: 'Total number of active resources.',
			registers: registry ? [registry] : undefined,
			labelNames,
			collect() {
				const resources = process.getActiveResourcesInfo();
				this.set(labels, resources.length);
			},
		});
	};

	processResources.exports.metricNames = [
		NODEJS_ACTIVE_RESOURCES,
		NODEJS_ACTIVE_RESOURCES_TOTAL,
	];
	return processResources.exports;
}

var heapSizeAndUsed = {exports: {}};

var hasRequiredHeapSizeAndUsed;

function requireHeapSizeAndUsed () {
	if (hasRequiredHeapSizeAndUsed) return heapSizeAndUsed.exports;
	hasRequiredHeapSizeAndUsed = 1;

	const Gauge = requireGauge();
	const safeMemoryUsage = requireSafeMemoryUsage();

	const NODEJS_HEAP_SIZE_TOTAL = 'nodejs_heap_size_total_bytes';
	const NODEJS_HEAP_SIZE_USED = 'nodejs_heap_size_used_bytes';
	const NODEJS_EXTERNAL_MEMORY = 'nodejs_external_memory_bytes';

	heapSizeAndUsed.exports = (registry, config = {}) => {
		if (typeof process.memoryUsage !== 'function') {
			return;
		}
		const labels = config.labels ? config.labels : {};
		const labelNames = Object.keys(labels);

		const registers = registry ? [registry] : undefined;
		const namePrefix = config.prefix ? config.prefix : '';
		const collect = () => {
			const memUsage = safeMemoryUsage();
			if (memUsage) {
				heapSizeTotal.set(labels, memUsage.heapTotal);
				heapSizeUsed.set(labels, memUsage.heapUsed);
				if (memUsage.external !== undefined) {
					externalMemUsed.set(labels, memUsage.external);
				}
			}
		};

		const heapSizeTotal = new Gauge({
			name: namePrefix + NODEJS_HEAP_SIZE_TOTAL,
			help: 'Process heap size from Node.js in bytes.',
			registers,
			labelNames,
			// Use this one metric's `collect` to set all metrics' values.
			collect,
		});
		const heapSizeUsed = new Gauge({
			name: namePrefix + NODEJS_HEAP_SIZE_USED,
			help: 'Process heap size used from Node.js in bytes.',
			registers,
			labelNames,
		});
		const externalMemUsed = new Gauge({
			name: namePrefix + NODEJS_EXTERNAL_MEMORY,
			help: 'Node.js external memory size in bytes.',
			registers,
			labelNames,
		});
	};

	heapSizeAndUsed.exports.metricNames = [
		NODEJS_HEAP_SIZE_TOTAL,
		NODEJS_HEAP_SIZE_USED,
		NODEJS_EXTERNAL_MEMORY,
	];
	return heapSizeAndUsed.exports;
}

var heapSpacesSizeAndUsed = {exports: {}};

var hasRequiredHeapSpacesSizeAndUsed;

function requireHeapSpacesSizeAndUsed () {
	if (hasRequiredHeapSpacesSizeAndUsed) return heapSpacesSizeAndUsed.exports;
	hasRequiredHeapSpacesSizeAndUsed = 1;

	const Gauge = requireGauge();
	const v8 = require$$1$2;

	const METRICS = ['total', 'used', 'available'];
	const NODEJS_HEAP_SIZE = {};

	METRICS.forEach(metricType => {
		NODEJS_HEAP_SIZE[metricType] = `nodejs_heap_space_size_${metricType}_bytes`;
	});

	heapSpacesSizeAndUsed.exports = (registry, config = {}) => {
		try {
			v8.getHeapSpaceStatistics();
		} catch (e) {
			if (e.code === 'ERR_NOT_IMPLEMENTED') {
				return; // Bun
			}
			throw e;
		}
		const registers = registry ? [registry] : undefined;
		const namePrefix = config.prefix ? config.prefix : '';

		const labels = config.labels ? config.labels : {};
		const labelNames = ['space', ...Object.keys(labels)];

		const gauges = {};

		METRICS.forEach(metricType => {
			gauges[metricType] = new Gauge({
				name: namePrefix + NODEJS_HEAP_SIZE[metricType],
				help: `Process heap space size ${metricType} from Node.js in bytes.`,
				labelNames,
				registers,
			});
		});

		// Use this one metric's `collect` to set all metrics' values.
		gauges.total.collect = () => {
			for (const space of v8.getHeapSpaceStatistics()) {
				const spaceName = space.space_name.substr(
					0,
					space.space_name.indexOf('_space'),
				);

				gauges.total.set({ space: spaceName, ...labels }, space.space_size);
				gauges.used.set({ space: spaceName, ...labels }, space.space_used_size);
				gauges.available.set(
					{ space: spaceName, ...labels },
					space.space_available_size,
				);
			}
		};
	};

	heapSpacesSizeAndUsed.exports.metricNames = Object.values(NODEJS_HEAP_SIZE);
	return heapSpacesSizeAndUsed.exports;
}

var version = {exports: {}};

var hasRequiredVersion;

function requireVersion () {
	if (hasRequiredVersion) return version.exports;
	hasRequiredVersion = 1;

	const Gauge = requireGauge();
	const version$1 = process.version;
	const versionSegments = version$1.slice(1).split('.').map(Number);

	const NODE_VERSION_INFO = 'nodejs_version_info';

	version.exports = (registry, config = {}) => {
		const namePrefix = config.prefix ? config.prefix : '';
		const labels = config.labels ? config.labels : {};
		const labelNames = Object.keys(labels);

		new Gauge({
			name: namePrefix + NODE_VERSION_INFO,
			help: 'Node.js version info.',
			labelNames: ['version', 'major', 'minor', 'patch', ...labelNames],
			registers: registry ? [registry] : undefined,
			aggregator: 'first',
			collect() {
				// Needs to be in collect() so value is present even if reg is reset
				this.labels(
					version$1,
					versionSegments[0],
					versionSegments[1],
					versionSegments[2],
					...Object.values(labels),
				).set(1);
			},
		});
	};

	version.exports.metricNames = [NODE_VERSION_INFO];
	return version.exports;
}

var gc = {exports: {}};

var hasRequiredGc;

function requireGc () {
	if (hasRequiredGc) return gc.exports;
	hasRequiredGc = 1;
	const Histogram = requireHistogram();

	let perf_hooks;

	try {
		// eslint-disable-next-line
		perf_hooks = require('perf_hooks');
	} catch {
		// node version is too old
	}

	const NODEJS_GC_DURATION_SECONDS = 'nodejs_gc_duration_seconds';
	const DEFAULT_GC_DURATION_BUCKETS = [0.001, 0.01, 0.1, 1, 2, 5];

	const kinds = [];

	if (perf_hooks && perf_hooks.constants) {
		kinds[perf_hooks.constants.NODE_PERFORMANCE_GC_MAJOR] = 'major';
		kinds[perf_hooks.constants.NODE_PERFORMANCE_GC_MINOR] = 'minor';
		kinds[perf_hooks.constants.NODE_PERFORMANCE_GC_INCREMENTAL] = 'incremental';
		kinds[perf_hooks.constants.NODE_PERFORMANCE_GC_WEAKCB] = 'weakcb';
	}

	gc.exports = (registry, config = {}) => {
		if (!perf_hooks) {
			return;
		}

		const namePrefix = config.prefix ? config.prefix : '';
		const labels = config.labels ? config.labels : {};
		const labelNames = Object.keys(labels);
		const buckets = config.gcDurationBuckets
			? config.gcDurationBuckets
			: DEFAULT_GC_DURATION_BUCKETS;
		const gcHistogram = new Histogram({
			name: namePrefix + NODEJS_GC_DURATION_SECONDS,
			help: 'Garbage collection duration by kind, one of major, minor, incremental or weakcb.',
			labelNames: ['kind', ...labelNames],
			enableExemplars: false,
			buckets,
			registers: registry ? [registry] : undefined,
		});

		const obs = new perf_hooks.PerformanceObserver(list => {
			const entry = list.getEntries()[0];
			// Node < 16 uses entry.kind
			// Node >= 16 uses entry.detail.kind
			// See: https://nodejs.org/docs/latest-v16.x/api/deprecations.html#deprecations_dep0152_extension_performanceentry_properties
			const kind = entry.detail ? kinds[entry.detail.kind] : kinds[entry.kind];
			// Convert duration from milliseconds to seconds
			gcHistogram.observe(Object.assign({ kind }, labels), entry.duration / 1000);
		});

		obs.observe({ entryTypes: ['gc'] });
	};

	gc.exports.metricNames = [NODEJS_GC_DURATION_SECONDS];
	return gc.exports;
}

var hasRequiredDefaultMetrics;

function requireDefaultMetrics () {
	if (hasRequiredDefaultMetrics) return defaultMetrics.exports;
	hasRequiredDefaultMetrics = 1;

	const { isObject } = requireUtil();

	// Default metrics.
	const processCpuTotal = requireProcessCpuTotal();
	const processStartTime = requireProcessStartTime();
	const osMemoryHeap = requireOsMemoryHeap();
	const processOpenFileDescriptors = requireProcessOpenFileDescriptors();
	const processMaxFileDescriptors = requireProcessMaxFileDescriptors();
	const eventLoopLag = requireEventLoopLag();
	const processHandles = requireProcessHandles();
	const processRequests = requireProcessRequests();
	const processResources = requireProcessResources();
	const heapSizeAndUsed = requireHeapSizeAndUsed();
	const heapSpacesSizeAndUsed = requireHeapSpacesSizeAndUsed();
	const version = requireVersion();
	const gc = requireGc();

	const metrics = {
		processCpuTotal,
		processStartTime,
		osMemoryHeap,
		processOpenFileDescriptors,
		processMaxFileDescriptors,
		eventLoopLag,
		...(typeof process.getActiveResourcesInfo === 'function'
			? { processResources }
			: {}),
		processHandles,
		processRequests,
		heapSizeAndUsed,
		heapSpacesSizeAndUsed,
		version,
		gc,
	};
	const metricsList = Object.keys(metrics);

	defaultMetrics.exports = function collectDefaultMetrics(config) {
		if (config !== null && config !== undefined && !isObject(config)) {
			throw new TypeError('config must be null, undefined, or an object');
		}

		config = { eventLoopMonitoringPrecision: 10, ...config };

		for (const metric of Object.values(metrics)) {
			metric(config.register, config);
		}
	};

	defaultMetrics.exports.metricsList = metricsList;
	return defaultMetrics.exports;
}

var metricAggregators = {};

var hasRequiredMetricAggregators;

function requireMetricAggregators () {
	if (hasRequiredMetricAggregators) return metricAggregators;
	hasRequiredMetricAggregators = 1;

	const { Grouper, hashObject } = requireUtil();

	/**
	 * Returns a new function that applies the `aggregatorFn` to the values.
	 * @param {Function} aggregatorFn function to apply to values.
	 * @return {Function} aggregator function
	 */
	function AggregatorFactory(aggregatorFn) {
		return metrics => {
			if (metrics.length === 0) return;
			const result = {
				help: metrics[0].help,
				name: metrics[0].name,
				type: metrics[0].type,
				values: [],
				aggregator: metrics[0].aggregator,
			};
			// Gather metrics by metricName and labels.
			const byLabels = new Grouper();
			metrics.forEach(metric => {
				metric.values.forEach(value => {
					const key = hashObject(value.labels);
					byLabels.add(`${value.metricName}_${key}`, value);
				});
			});
			// Apply aggregator function to gathered metrics.
			byLabels.forEach(values => {
				if (values.length === 0) return;
				const valObj = {
					value: aggregatorFn(values),
					labels: values[0].labels,
				};
				if (values[0].metricName) {
					valObj.metricName = values[0].metricName;
				}
				// NB: Timestamps are omitted.
				result.values.push(valObj);
			});
			return result;
		};
	}
	// Export for users to define their own aggregation methods.
	metricAggregators.AggregatorFactory = AggregatorFactory;

	/**
	 * Functions that can be used to aggregate metrics from multiple registries.
	 */
	metricAggregators.aggregators = {
		/**
		 * @return The sum of values.
		 */
		sum: AggregatorFactory(v => v.reduce((p, c) => p + c.value, 0)),
		/**
		 * @return The first value.
		 */
		first: AggregatorFactory(v => v[0].value),
		/**
		 * @return {undefined} Undefined; omits the metric.
		 */
		omit: () => {},
		/**
		 * @return The arithmetic mean of the values.
		 */
		average: AggregatorFactory(
			v => v.reduce((p, c) => p + c.value, 0) / v.length,
		),
		/**
		 * @return The minimum of the values.
		 */
		min: AggregatorFactory(v =>
			v.reduce((p, c) => Math.min(p, c.value), Infinity),
		),
		/**
		 * @return The maximum of the values.
		 */
		max: AggregatorFactory(v =>
			v.reduce((p, c) => Math.max(p, c.value), -Infinity),
		),
	};
	return metricAggregators;
}

var cluster_1;
var hasRequiredCluster;

function requireCluster () {
	if (hasRequiredCluster) return cluster_1;
	hasRequiredCluster = 1;

	/**
	 * Extends the Registry class with a `clusterMetrics` method that returns
	 * aggregated metrics for all workers.
	 *
	 * In cluster workers, listens for and responds to requests for metrics by the
	 * cluster master.
	 */

	const Registry = requireRegistry();
	const { Grouper } = requireUtil();
	const { aggregators } = requireMetricAggregators();
	// We need to lazy-load the 'cluster' module as some application servers -
	// namely Passenger - crash when it is imported.
	let cluster = () => {
		const data = require$$3$1;
		cluster = () => data;
		return data;
	};

	const GET_METRICS_REQ = 'prom-client:getMetricsReq';
	const GET_METRICS_RES = 'prom-client:getMetricsRes';

	let registries = [Registry.globalRegistry];
	let requestCtr = 0; // Concurrency control
	let listenersAdded = false;
	const requests = new Map(); // Pending requests for workers' local metrics.

	class AggregatorRegistry extends Registry {
		constructor(regContentType = Registry.PROMETHEUS_CONTENT_TYPE) {
			super(regContentType);
			addListeners();
		}

		/**
		 * Gets aggregated metrics for all workers. The optional callback and
		 * returned Promise resolve with the same value; either may be used.
		 * @return {Promise<string>} Promise that resolves with the aggregated
		 *   metrics.
		 */
		clusterMetrics() {
			const requestId = requestCtr++;

			return new Promise((resolve, reject) => {
				let settled = false;
				function done(err, result) {
					if (settled) return;
					settled = true;
					if (err) reject(err);
					else resolve(result);
				}

				const request = {
					responses: [],
					pending: 0,
					done,
					errorTimeout: setTimeout(() => {
						const err = new Error('Operation timed out.');
						request.done(err);
					}, 5000),
				};
				requests.set(requestId, request);

				const message = {
					type: GET_METRICS_REQ,
					requestId,
				};

				for (const id in cluster().workers) {
					// If the worker exits abruptly, it may still be in the workers
					// list but not able to communicate.
					if (cluster().workers[id].isConnected()) {
						cluster().workers[id].send(message);
						request.pending++;
					}
				}

				if (request.pending === 0) {
					// No workers were up
					clearTimeout(request.errorTimeout);
					process.nextTick(() => done(null, ''));
				}
			});
		}

		get contentType() {
			return super.contentType;
		}

		/**
		 * Creates a new Registry instance from an array of metrics that were
		 * created by `registry.getMetricsAsJSON()`. Metrics are aggregated using
		 * the method specified by their `aggregator` property, or by summation if
		 * `aggregator` is undefined.
		 * @param {Array} metricsArr Array of metrics, each of which created by
		 *   `registry.getMetricsAsJSON()`.
		 * @param {string} registryType content type of the new registry. Defaults
		 * to PROMETHEUS_CONTENT_TYPE.
		 * @return {Registry} aggregated registry.
		 */
		static aggregate(
			metricsArr,
			registryType = Registry.PROMETHEUS_CONTENT_TYPE,
		) {
			const aggregatedRegistry = new Registry();
			const metricsByName = new Grouper();

			aggregatedRegistry.setContentType(registryType);

			// Gather by name
			metricsArr.forEach(metrics => {
				metrics.forEach(metric => {
					metricsByName.add(metric.name, metric);
				});
			});

			// Aggregate gathered metrics.
			metricsByName.forEach(metrics => {
				const aggregatorName = metrics[0].aggregator;
				const aggregatorFn = aggregators[aggregatorName];
				if (typeof aggregatorFn !== 'function') {
					throw new Error(`'${aggregatorName}' is not a defined aggregator.`);
				}
				const aggregatedMetric = aggregatorFn(metrics);
				// NB: The 'omit' aggregator returns undefined.
				if (aggregatedMetric) {
					const aggregatedMetricWrapper = Object.assign(
						{
							get: () => aggregatedMetric,
						},
						aggregatedMetric,
					);
					aggregatedRegistry.registerMetric(aggregatedMetricWrapper);
				}
			});

			return aggregatedRegistry;
		}

		/**
		 * Sets the registry or registries to be aggregated. Call from workers to
		 * use a registry/registries other than the default global registry.
		 * @param {Array<Registry>|Registry} regs Registry or registries to be
		 *   aggregated.
		 * @return {void}
		 */
		static setRegistries(regs) {
			if (!Array.isArray(regs)) regs = [regs];
			regs.forEach(reg => {
				if (!(reg instanceof Registry)) {
					throw new TypeError(`Expected Registry, got ${typeof reg}`);
				}
			});
			registries = regs;
		}
	}

	/**
	 * Adds event listeners for cluster aggregation. Idempotent (safe to call more
	 * than once).
	 * @return {void}
	 */
	function addListeners() {
		if (listenersAdded) return;
		listenersAdded = true;

		if (cluster().isMaster) {
			// Listen for worker responses to requests for local metrics
			cluster().on('message', (worker, message) => {
				if (message.type === GET_METRICS_RES) {
					const request = requests.get(message.requestId);

					if (message.error) {
						request.done(new Error(message.error));
						return;
					}

					message.metrics.forEach(registry => request.responses.push(registry));
					request.pending--;

					if (request.pending === 0) {
						// finalize
						requests.delete(message.requestId);
						clearTimeout(request.errorTimeout);

						const registry = AggregatorRegistry.aggregate(request.responses);
						const promString = registry.metrics();
						request.done(null, promString);
					}
				}
			});
		}

		if (cluster().isWorker) {
			// Respond to master's requests for worker's local metrics.
			process.on('message', message => {
				if (message.type === GET_METRICS_REQ) {
					Promise.all(registries.map(r => r.getMetricsAsJSON()))
						.then(metrics => {
							process.send({
								type: GET_METRICS_RES,
								requestId: message.requestId,
								metrics,
							});
						})
						.catch(error => {
							process.send({
								type: GET_METRICS_RES,
								requestId: message.requestId,
								error: error.message,
							});
						});
				}
			});
		}
	}

	cluster_1 = AggregatorRegistry;
	return cluster_1;
}

/**
 * Prometheus client
 * @module Prometheus client
 */

var hasRequiredPromClient;

function requirePromClient () {
	if (hasRequiredPromClient) return promClient;
	hasRequiredPromClient = 1;
	(function (exports) {

		exports.register = requireRegistry().globalRegistry;
		exports.Registry = requireRegistry();
		Object.defineProperty(exports, 'contentType', {
			configurable: false,
			enumerable: true,
			get() {
				return exports.register.contentType;
			},
			set(value) {
				exports.register.setContentType(value);
			},
		});
		exports.prometheusContentType = exports.Registry.PROMETHEUS_CONTENT_TYPE;
		exports.openMetricsContentType = exports.Registry.OPENMETRICS_CONTENT_TYPE;
		exports.validateMetricName = requireValidation().validateMetricName;

		exports.Counter = requireCounter();
		exports.Gauge = requireGauge();
		exports.Histogram = requireHistogram();
		exports.Summary = requireSummary();
		exports.Pushgateway = requirePushgateway();

		exports.linearBuckets = requireBucketGenerators().linearBuckets;
		exports.exponentialBuckets =
			requireBucketGenerators().exponentialBuckets;

		exports.collectDefaultMetrics = requireDefaultMetrics();

		exports.aggregators = requireMetricAggregators().aggregators;
		exports.AggregatorRegistry = requireCluster(); 
	} (promClient));
	return promClient;
}

var promClientExports = requirePromClient();

exports.client = promClientExports.register;
