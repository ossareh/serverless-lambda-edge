module.exports = function (grunt) {
	const config = {
		js: {
			all: [
				'Gruntfile.js',
				'src/**/*.js',
				'!**/node_modules/**/*',
			],
		},
	};

	grunt.initConfig({
		pkg: grunt.file.readJSON('package.json'),

		eslint: {
			target: config.js.all,
		},

		// TODO: add auto running tests when there are meaningful tests to run
		watch: {
			js: {
				files: config.js.all,
				tasks: ['eslint'],
			},
		},

	});

	grunt.loadNpmTasks('grunt-eslint');
	grunt.loadNpmTasks('grunt-contrib-watch');

	grunt.registerTask('standards', ['eslint']);
	grunt.registerTask('default', ['standards']);
};
