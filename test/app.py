from flask import Flask, render_template
from quran_pedia_bp import quran_pedia_bp

app = Flask(__name__)
app.register_blueprint(quran_pedia_bp)

@app.route('/')
def index():
    return render_template('quran_reader.html')

if __name__ == '__main__':
    app.run(debug=True, port=5050)
