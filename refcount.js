export default class RefCount {
	constructor(startRefNumber) {
		this._resolve = null;
		this._promise = new Promise(resolve => this._resolve = resolve);
		this._current = startRefNumber || 0;
	}

	addRef() {
		this._current++;
	}

	removeRef() {
		this._current--;
		if (this._current === 0) {
			this._resolve && this._resolve();
		}
	}

	add(promise) {
		this.addRef();
		promise.then(() => this.removeRef());
	}

	get current() {
		return this._current;
	}

	get done() {
		return this._promise;
	}
}